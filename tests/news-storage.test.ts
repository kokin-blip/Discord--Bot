import { expect, it } from 'vitest';
import { Store } from '../src/storage.js';
import { NewsStore, initializeNews } from '../src/news/store.js';
import { initializeNewsSchema, newsMigrations } from '../src/news/schema.js';
import { now, observation, policy } from './news-fixtures.js';
import { equity } from '../src/domain.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const count = (s: Store, table: string) =>
  (s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
function approve(n: NewsStore, provider: 'marketaux' | 'currents' = 'marketaux') {
  n.savePolicy(policy('provider', provider));
  n.savePolicy(policy('publisher', provider));
}
it('adds all tables idempotently without changing existing data or version', () => {
  const s = new Store(':memory:');
  try {
    s.pin(equity('TEST'));
    const journal = s.journal(),
      settings = s.settings(),
      version = s.db.prepare('PRAGMA user_version').get();
    new NewsStore(s, now);
    new NewsStore(s, now + 1);
    expect(count(s, 'news_migrations')).toBe(newsMigrations.length);
    for (const table of [
      'news_source_policies',
      'news_articles',
      'news_observations',
      'news_aliases',
      'news_instrument_links',
      'news_events',
      'news_event_articles',
      'news_sentiments',
      'news_queries',
      'news_quota_days',
      'news_quota_reservations',
      'news_deliveries',
      'news_delivery_items',
    ])
      expect(count(s, table)).toBe(0);
    expect(s.journal()).toEqual(journal);
    expect(s.settings()).toEqual(settings);
    expect(s.db.prepare('PRAGMA user_version').get()).toEqual(version);
    expect(() => s.db.exec('DELETE FROM events')).toThrow('append-only');
  } finally {
    s.close();
  }
});
it('rolls back a failed migration and isolates initialization failure from market storage', () => {
  const s = new Store(':memory:');
  try {
    expect(() =>
      initializeNewsSchema(s, now, [
        { version: 1, sql: 'CREATE TABLE news_partial(id TEXT); INVALID SQL;' },
      ]),
    ).toThrow();
    expect(s.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'news_%'").all()).toEqual(
      [],
    );
    s.db.exec('CREATE TABLE news_articles(id TEXT)');
    expect(initializeNews(s, now)).toEqual({ news: null, error: 'NEWS_INITIALIZATION_FAILED' });
    s.pin(equity('STILLWORKS'));
    expect(s.monitored().map((i) => i.symbol)).toContain('STILLWORKS');
    s.db.exec('DROP TABLE news_articles');
    expect(initializeNews(s, now).news).toBeInstanceOf(NewsStore);
    expect(count(s, 'news_migrations')).toBe(newsMigrations.length);
  } finally {
    s.close();
  }
});
it('denies unlicensed persistence and strips unlicensed text/entities', () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    expect(() => n.saveObservation(observation(), now)).toThrow('NEWS_STORAGE_DENIED');
    expect(count(s, 'news_articles')).toBe(0);
    approve(n);
    n.saveObservation(observation(), now);
    expect(n.observation('marketaux', 'synthetic-1', now)).toMatchObject({
      headline: null,
      description: null,
      entities: [],
      publishedAt: now - 1000,
      ingestedAt: now,
      policyVersions: ['marketaux-provider@1', 'marketaux-publisher@1'],
    });
    expect(JSON.stringify(s.db.prepare('SELECT body FROM news_observations').all())).not.toContain(
      'Synthetic earnings headline',
    );
    expect(() => n.savePolicy({ ...policy('provider'), evidence: 'changed' })).toThrow(
      'NEWS_POLICY_IMMUTABLE',
    );
  } finally {
    s.close();
  }
});
it('deduplicates URLs and provider identities across restarts without extending retention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-storage-')),
    path = join(dir, 'db.sqlite');
  let s = new Store(path);
  try {
    let n = new NewsStore(s, now);
    approve(n);
    approve(n, 'currents');
    const first = n.saveObservation(observation(), now);
    n.saveObservation(observation({ attemptId: 'retry', ingestedAt: now + 100 }), now + 100);
    const second = n.saveObservation(
      observation({
        provider: 'currents',
        providerArticleId: 'currents-1',
        url: 'https://publisher.example/story?id=1',
      }),
      now,
    );
    expect(second.articleId).toBe(first.articleId);
    expect(second.observationId).not.toBe(first.observationId);
    expect(count(s, 'news_articles')).toBe(1);
    expect(count(s, 'news_observations')).toBe(2);
    expect(() =>
      n.saveObservation(observation({ url: 'https://publisher.example/other' }), now),
    ).toThrow('NEWS_IDENTITY_CONFLICT');
    s.close();
    s = new Store(path);
    n = new NewsStore(s, now);
    expect(n.observation('marketaux', 'synthetic-1', now)?.ingestedAt).toBe(now);
    expect(n.observation('marketaux', 'synthetic-1', now + 3600000)).toBeNull();
    expect(n.cleanup(now + 3600000)).toBe(2);
    expect(count(s, 'news_articles')).toBe(0);
  } finally {
    s.close();
    rmSync(dir, { recursive: true });
  }
});
it('hides revoked evidence immediately and cleans it without relying on foreign keys', () => {
  const s = new Store(':memory:');
  try {
    s.db.exec('PRAGMA foreign_keys=OFF');
    const n = new NewsStore(s, now);
    approve(n);
    n.saveObservation(observation(), now);
    n.savePolicy(policy('publisher', 'marketaux', { version: 2, status: 'revoked' }));
    expect(n.observation('marketaux', 'synthetic-1', now)).toBeNull();
    expect(n.cleanup(now, 1)).toBe(1);
    expect(count(s, 'news_articles')).toBe(0);
  } finally {
    s.close();
  }
});
it('removes only revoked fields and applies shortened retention on reads and cleanup', () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    for (const scope of ['provider', 'publisher'] as const) {
      const p = policy(scope);
      n.savePolicy({
        ...p,
        permissions: {
          ...p.permissions,
          retainHeadline: true,
          retainDescription: true,
          analyze: true,
          retainDerived: true,
        },
      });
    }
    n.saveObservation(observation(), now);
    expect(n.observation('marketaux', 'synthetic-1', now)?.headline).toBe(
      'Synthetic earnings headline',
    );
    n.savePolicy(policy('publisher', 'marketaux', { version: 2, retentionMs: 1000 }));
    expect(n.observation('marketaux', 'synthetic-1', now)).toMatchObject({
      headline: null,
      description: null,
      entities: [],
    });
    n.cleanup(now);
    expect(JSON.stringify(s.db.prepare('SELECT body FROM news_observations').all())).not.toContain(
      'Synthetic earnings headline',
    );
    expect(n.observation('marketaux', 'synthetic-1', now + 1000)).toBeNull();
    expect(n.cleanup(now + 1000)).toBe(1);
  } finally {
    s.close();
  }
});
it('suppresses queued news on rights review and preserves immutable journal and receipts', () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    approve(n);
    const { articleId } = n.saveObservation(observation(), now);
    s.db
      .prepare('INSERT INTO events(id,idea_id,body) VALUES(?,?,?)')
      .run('news-audit', 'news-reference', '{"deliveryId":"delivery-1"}');
    s.db.prepare('INSERT INTO outbox(event_id,route) VALUES(?,?)').run('news-audit', 'summaries');
    s.saveReceipt('news-audit', 'test-channel', 'test-message');
    s.db
      .prepare('INSERT INTO news_deliveries VALUES(?,?,?,?,?,?)')
      .run('delivery-1', 'news-audit', 'digest', now, now + 1000, 'pending');
    s.db
      .prepare('INSERT INTO news_delivery_items VALUES(?,?,?,?,?)')
      .run('delivery-1', articleId, null, '[]', now + 1000);
    n.savePolicy(policy('publisher', 'marketaux', { version: 2, status: 'revoked' }));
    expect(s.db.prepare('SELECT status FROM outbox WHERE event_id=?').get('news-audit')).toEqual({
      status: 'suppressed',
    });
    expect(n.cleanup(now)).toBe(1);
    expect(count(s, 'news_delivery_items')).toBe(0);
    expect(count(s, 'events')).toBe(1);
    expect(s.receipt('news-audit', 'test-channel')).toBe('test-message');
    expect(() => s.db.exec('DELETE FROM events')).toThrow('append-only');
  } finally {
    s.close();
  }
});
it('cleans shared cluster dependencies and suppresses every affected delivery', () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    approve(n);
    const first = n.saveObservation(observation(), now);
    const second = n.saveObservation(
      observation({ providerArticleId: 'synthetic-2', url: 'https://publisher.example/other' }),
      now,
    );
    s.db
      .prepare('INSERT INTO news_events VALUES(?,?,?,?,?,?,?,?,?)')
      .run('cluster', 'TEST', 'earnings', 'low', now, now, now + 1000, 'news-rules-v1', '{}');
    for (const articleId of [first.articleId, second.articleId])
      s.db.prepare('INSERT INTO news_event_articles VALUES(?,?)').run('cluster', articleId);
    s.db
      .prepare('INSERT INTO news_sentiments VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        'sentiment',
        null,
        'cluster',
        'TEST',
        'local',
        0.1,
        0.5,
        'news-rules-v1',
        now + 1000,
        '{}',
      );
    s.db
      .prepare('INSERT INTO events(id,idea_id,body) VALUES(?,?,?)')
      .run('news-shared', 'news-reference', '{}');
    s.db.prepare('INSERT INTO outbox(event_id,route) VALUES(?,?)').run('news-shared', 'summaries');
    s.db
      .prepare('INSERT INTO news_deliveries VALUES(?,?,?,?,?,?)')
      .run('shared-delivery', 'news-shared', 'digest', now, now + 1000, 'pending');
    s.db
      .prepare('INSERT INTO news_delivery_items VALUES(?,?,?,?,?)')
      .run('shared-delivery', second.articleId, 'cluster', '[]', now + 1000);
    n.cleanup(now + 3600000);
    expect(count(s, 'news_events')).toBe(0);
    expect(count(s, 'news_sentiments')).toBe(0);
    expect(count(s, 'news_event_articles')).toBe(0);
    expect(count(s, 'news_delivery_items')).toBe(0);
    expect(s.db.prepare('SELECT status FROM outbox WHERE event_id=?').get('news-shared')).toEqual({
      status: 'suppressed',
    });
    expect(count(s, 'events')).toBe(1);
  } finally {
    s.close();
  }
});
