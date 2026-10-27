import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/storage.js';
import { equity } from '../src/domain.js';
import { NewsStore } from '../src/news/store.js';
import { NewsIntelligence } from '../src/news/intelligence.js';
import { NEWS_LIMITS } from '../src/news/config.js';
import { now, observation, policy } from './news-fixtures.js';
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture(analyze = true) {
  const store = new Store(':memory:');
  stores.push(store);
  const news = new NewsStore(store, now),
    engine = new NewsIntelligence(news),
    instrument = equity('TEST');
  store.pin(instrument);
  news.saveConfig({ ...news.config(), enabled: true });
  for (const provider of ['marketaux', 'currents', 'gdelt'] as const)
    for (const scope of ['provider', 'publisher'] as const) {
      const p = policy(scope, provider);
      news.savePolicy({
        ...p,
        permissions: {
          ...p.permissions,
          retainHeadline: true,
          retainDescription: true,
          analyze,
          retainDerived: analyze,
        },
      });
    }
  const alias = {
    id: 'issuer',
    instrumentId: instrument.id,
    alias: 'Test Company',
    venue: 'NASDAQ',
    reviewedAt: now - 1,
    expiresAt: now + 3600000,
    evidence: 'Synthetic human-reviewed fixture',
    ambiguous: false,
    contextTerms: [],
  };
  news.saveAlias(alias);
  news.savePublisherGroup({
    domain: 'publisher.example',
    groupId: 'publisher-owner',
    reviewedAt: now - 1,
    expiresAt: now + 3600000,
    evidence: 'Synthetic ownership review',
  });
  const add = (overrides: Record<string, unknown> = {}) =>
    news.saveObservation(
      observation({
        headline: 'Test Company quarterly earnings beats estimates',
        description: null,
        ...overrides,
      }),
      now,
    );
  const events = () =>
    store.db.prepare('SELECT id,event_time,body FROM news_events ORDER BY id').all() as {
      id: string;
      event_time: number | null;
      body: string;
    }[];
  const count = (table: string) =>
    (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { store, news, engine, instrument, alias, add, events, count };
}
it('persists explainable analytics separately and leaves trading state unchanged', () => {
  const f = fixture(),
    settings = f.store.settings(),
    journal = f.store.journal(),
    instruments = f.store.monitored();
  f.add();
  expect(f.engine.process(now)).toEqual({ processed: 1, unchanged: 0, failed: 0 });
  const [row] = f.events(),
    report = f.engine.event(row!.id, now);
  expect(report?.cluster).toMatchObject({
    topic: `instrument:${f.instrument.id}`,
    eventClass: 'earnings_guidance',
  });
  expect(report?.summary).toMatchObject({
    freshness: 'fresh',
    independentPublishers: 1,
    mappingConfidence: 0.95,
  });
  expect(row!.body).not.toContain('Test Company quarterly earnings beats estimates');
  expect(
    f.engine
      .sentiments(f.instrument.id, now)
      .map((s) => [s.origin, s.score])
      .sort(),
  ).toEqual([
    ['local', 1],
    ['marketaux', 0.4],
  ]);
  expect(f.store.settings()).toEqual(settings);
  expect(f.store.journal()).toEqual(journal);
  expect(f.store.monitored()).toEqual(instruments);
  f.news.enqueueAnalysis(report!.cluster.evidence[0]!.articleId, now);
  expect(new NewsIntelligence(f.news).process(now)).toEqual({
    processed: 0,
    unchanged: 1,
    failed: 0,
  });
  expect(f.events()).toEqual([row]);
});
it('deduplicates providers and syndicated copies without inflating corroboration', () => {
  const f = fixture();
  f.add();
  f.add({
    provider: 'currents',
    providerArticleId: 'c1',
    url: 'https://publisher.example/story?id=1',
  });
  f.add({ providerArticleId: 'copy', url: 'https://publisher.example/copy' });
  expect(f.engine.process(now).processed).toBe(2);
  expect(f.count('news_articles')).toBe(2);
  expect(f.events()).toHaveLength(1);
  const report = f.engine.event(f.events()[0]!.id, now)!;
  expect(report.cluster.evidence).toHaveLength(2);
  expect(report.cluster.evidence.map((e) => e.observations.length).sort()).toEqual([1, 2]);
  expect(report.summary.independentPublishers).toBe(1);
  f.add({
    providerArticleId: 'different',
    url: 'https://publisher.example/other',
    headline: 'Test Company Q2 2026 cuts guidance',
  });
  f.engine.process(now);
  expect(f.events()).toHaveLength(2);
});
it('denies analysis without permissions and rechecks revocation before returning stored results', () => {
  const denied = fixture(false);
  denied.add();
  denied.engine.process(now);
  expect(denied.events()).toEqual([]);
  expect(denied.count('news_sentiments')).toBe(0);
  const f = fixture();
  f.add();
  f.engine.process(now);
  const id = f.events()[0]!.id;
  f.news.savePolicy(policy('publisher', 'marketaux', { version: 2, status: 'revoked' }));
  expect(f.engine.event(id, now)).toBeNull();
  expect(f.engine.sentiments(f.instrument.id, now)).toEqual([]);
  f.news.cleanup(now);
  expect(f.events()).toEqual([]);
  expect(f.count('news_sentiments')).toBe(0);
});
it('invalidates mappings on expired reviews and reprocesses affected evidence', () => {
  const f = fixture();
  f.add({ entities: [] });
  f.engine.process(now);
  const id = f.events()[0]!.id;
  expect(f.engine.event(id, now)?.summary.mappingConfidence).toBe(0.9);
  f.news.saveAlias({ ...f.alias, expiresAt: now + 1 });
  expect(f.engine.event(id, now + 2)).toBeNull();
  expect(f.engine.sentiments(f.instrument.id, now + 2)).toEqual([]);
  f.engine.process(now + 2);
  expect(f.count('news_instrument_links')).toBe(0);
  expect(f.engine.sentiments(null, now + 2)[0]?.score).toBe(1);
});
it('preserves first-seen provenance and refuses future ingestion in historical analysis', () => {
  const f = fixture();
  f.add({
    provider: 'gdelt',
    providerArticleId: 'g1',
    publishedAt: null,
    firstSeenAt: now,
    timestampBasis: 'provider_first_seen',
    entities: [],
  });
  f.engine.process(now);
  const row = f.events()[0]!;
  expect(row.event_time).toBeNull();
  expect(f.engine.event(row.id, now)?.summary.freshness).toBe('unknown');
  const future = observation({
    providerArticleId: 'future',
    url: 'https://publisher.example/future',
    headline: 'Test Company quarterly earnings beats estimates',
    description: null,
    ingestedAt: now + 1000,
  });
  expect(() => f.news.saveObservation(future, now)).toThrow('NEWS_FUTURE_INGESTION');
  f.news.saveObservation(future, now + 1000);
  f.engine.process(now);
  expect(f.count('news_analysis_queue')).toBe(1);
  expect(f.events()[0]!.body).not.toContain('future');
  f.engine.process(now + 1000);
  expect(f.count('news_event_articles')).toBe(2);
});
it('limits processing to twenty articles and recovers a durable failed attempt', () => {
  const f = fixture();
  for (let i = 0; i < 21; i++)
    f.add({ providerArticleId: `p${i}`, url: `https://publisher.example/${i}` });
  const original = f.news.analysisObservations.bind(f.news),
    spy = vi.spyOn(f.news, 'analysisObservations').mockImplementationOnce(() => {
      throw new Error('synthetic failure');
    });
  expect(f.engine.process(now)).toMatchObject({ processed: 19, failed: 1 });
  spy.mockImplementation(original);
  expect(f.engine.process(now).processed).toBe(1);
  expect(f.engine.process(now + 60000)).toMatchObject({ processed: 1, failed: 0 });
  expect(f.count('news_analysis_queue')).toBe(0);
  expect(f.events()).toHaveLength(2); // twenty-item evidence ceiling
});
it('rolls back partial analysis on resource or storage guards without losing queued work', () => {
  const f = fixture();
  f.add();
  let calls = 0;
  expect(f.engine.process(now, () => ++calls < 4)).toEqual({
    processed: 0,
    unchanged: 0,
    failed: 0,
  });
  expect(f.events()).toEqual([]);
  expect(f.count('news_instrument_links')).toBe(0);
  expect(f.count('news_analysis_queue')).toBe(1);
  f.store.set('news_storage_estimate', { day: '2026-10-09', bytes: NEWS_LIMITS.storageBytes });
  f.engine.process(now);
  expect(f.events()).toEqual([]);
  expect(f.count('news_analysis_queue')).toBe(1);
  f.store.set('news_storage_estimate', { day: '2026-10-09', bytes: 0 });
  expect(f.engine.process(now).processed).toBe(1);
});
it('fails closed for malformed stored events and sentiment explanations', () => {
  const f = fixture();
  f.add();
  f.engine.process(now);
  const id = f.events()[0]!.id;
  f.store.db.prepare('UPDATE news_events SET body=? WHERE id=?').run('{broken', id);
  f.store.db.prepare('UPDATE news_sentiments SET body=?').run('{broken');
  expect(f.engine.event(id, now)).toBeNull();
  expect(f.engine.sentiments(f.instrument.id, now)).toEqual([]);
});
it('examines at most fifty cluster candidates for each article', () => {
  const f = fixture();
  f.add();
  f.engine.process(now);
  const first = f.events()[0]!,
    original = JSON.parse(first.body);
  f.store.db.exec('DELETE FROM news_event_articles');
  f.store.db.exec('DELETE FROM news_events');
  f.store.set('news_event_count', null);
  for (let i = 0; i < 51; i++) {
    const body = structuredClone(original);
    if (i < 50) body.evidence[0].titleTokens = ['different-topic'];
    f.store.db
      .prepare('INSERT INTO news_events VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        `candidate-${i}`,
        body.topic,
        body.eventClass,
        'medium',
        now,
        now - 100 + i,
        now + 1000,
        body.version,
        JSON.stringify(body),
      );
    f.store.db
      .prepare('INSERT INTO news_event_articles VALUES(?,?)')
      .run(`candidate-${i}`, body.evidence[0].articleId);
  }
  f.add({ providerArticleId: 'candidate-target', url: 'https://publisher.example/target' });
  expect(f.engine.process(now).processed).toBe(1);
  expect(f.events()).toHaveLength(52); // the matching 51st candidate is intentionally not examined
  const last = JSON.parse(f.events().find((e) => e.id === 'candidate-50')!.body);
  expect(last.evidence).toHaveLength(1);
});
