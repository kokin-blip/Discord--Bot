import { expect, it, vi } from 'vitest';
import { Store } from '../src/storage.js';
import { NewsStore } from '../src/news/store.js';
import { NewsIngestion } from '../src/news/ingestion.js';
import { NewsScheduler } from '../src/news/scheduler.js';
import { NewsError } from '../src/news/transport.js';
import type { NewsAdapter, NewsPage, NewsProvider, NewsQuery } from '../src/news/types.js';
import { now, observation, policy } from './news-fixtures.js';
import { equity } from '../src/domain.js';
const count = (s: Store, table: string) =>
  (s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
function approve(n: NewsStore, provider: NewsProvider) {
  n.savePolicy(policy('provider', provider));
  n.savePolicy(policy('publisher', provider));
}
function page(q: NewsQuery, time = now): NewsPage {
  return {
    observations: [
      {
        ...observation({
          provider: q.provider,
          ingestedAt: time,
          publishedAt: q.provider === 'gdelt' ? null : time - 1000,
          firstSeenAt: q.provider === 'gdelt' ? time - 1000 : null,
          timestampBasis: q.provider === 'gdelt' ? 'provider_first_seen' : 'publication',
        }),
      } as NewsPage['observations'][number],
    ],
    pagination: { truncated: true, nextPage: null },
    quota: { remaining: null, retryAt: null, exhausted: false },
  };
}
function adapters(fn: (q: NewsQuery) => Promise<NewsPage>): Record<NewsProvider, NewsAdapter> {
  const adapter = (provider: NewsProvider): NewsAdapter => ({ provider, fetchPage: vi.fn(fn) });
  return {
    marketaux: adapter('marketaux'),
    currents: adapter('currents'),
    gdelt: adapter('gdelt'),
  };
}
it('makes no requests while disabled, missing credentials, or missing source permission', async () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now),
      a = adapters(async (q) => page(q)),
      ingestion = new NewsIngestion(n, {}, () => now, undefined, a);
    expect((await ingestion.tick(now)).status).toBe('disabled');
    expect(count(s, 'news_queries')).toBe(0);
    n.saveConfig({ enabled: true, providers: { marketaux: true, gdelt: true } });
    expect((await ingestion.tick(now)).status).toBe('idle');
    expect(ingestion.scheduler.quota.state('marketaux').diagnostic).toBe('NEWS_CREDENTIAL_MISSING');
    n.savePolicy(policy('provider', 'gdelt'));
    expect((await ingestion.tick(now)).status).toBe('idle');
    expect(count(s, 'news_quota_reservations')).toBe(0);
    expect(a.gdelt.fetchPage).not.toHaveBeenCalled();
    expect(a.marketaux.fetchPage).not.toHaveBeenCalled();
  } finally {
    s.close();
  }
});
it('ingests permitted metadata, strips unlicensed fields, and enforces one attempt per minute', async () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    approve(n, 'gdelt');
    n.saveConfig({ enabled: true, providers: { gdelt: true } });
    const a = adapters(async (q) => page(q)),
      ingestion = new NewsIngestion(n, {}, () => now, undefined, a);
    expect((await ingestion.tick(now)).status).toBe('complete');
    const independent = new NewsIngestion(n, {}, () => now, undefined, a);
    expect((await independent.tick(now)).status).toBe('idle');
    expect(a.gdelt.fetchPage).toHaveBeenCalledTimes(1);
    expect(count(s, 'news_observations')).toBe(1);
    expect(count(s, 'news_quota_reservations')).toBe(1);
    expect(n.observation('gdelt', 'synthetic-1', now)).toMatchObject({
      headline: null,
      description: null,
      publishedAt: null,
      firstSeenAt: now - 1000,
    });
    const checkpoint = s.db
      .prepare('SELECT checkpoint FROM news_queries WHERE checkpoint IS NOT NULL')
      .get() as { checkpoint: string };
    expect(JSON.parse(checkpoint.checkpoint)).toMatchObject({
      through: now,
      truncated: true,
      stored: 1,
    });
    expect(JSON.stringify(s.db.prepare('SELECT * FROM news_queries').all())).not.toContain(
      'Synthetic earnings headline',
    );
  } finally {
    s.close();
  }
});
it('rechecks rights after await and suppresses unapproved domains without affecting market soak', async () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    approve(n, 'gdelt');
    n.saveConfig({ enabled: true, providers: { gdelt: true } });
    s.set('soak_start', now - 7 * 86400000);
    const a = adapters(async (q) => {
      n.savePolicy(policy('publisher', 'gdelt', { version: 2, status: 'revoked' }));
      const result = page(q);
      result.observations.push({
        ...result.observations[0]!,
        providerArticleId: 'other',
        url: 'https://unapproved.example/story',
      });
      return result;
    });
    const ingestion = new NewsIngestion(n, {}, () => now, undefined, a);
    expect((await ingestion.tick(now)).status).toBe('complete');
    expect(count(s, 'news_observations')).toBe(0);
    expect(s.get('news_last_result', {})).toMatchObject({ suppressed: 2 });
    expect(s.get('soak_start', 0)).toBe(now - 7 * 86400000);
  } finally {
    s.close();
  }
});
it('schedules retries without sleeping and retains checkpoints until successful completion', async () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    approve(n, 'currents');
    n.saveConfig({ enabled: true, providers: { currents: true } });
    let time = now;
    const a = adapters(async () => {
      throw new NewsError('NEWS_TIMEOUT');
    });
    const ingestion = new NewsIngestion(
      n,
      { CURRENTS_API_KEY: 'private-key' },
      () => time,
      undefined,
      a,
    );
    expect((await ingestion.tick(time)).diagnostic).toBe('NEWS_TIMEOUT');
    expect(count(s, 'news_quota_reservations')).toBe(1);
    time += 30000;
    expect((await ingestion.tick(time)).status).toBe('idle');
    time += 30000;
    expect((await ingestion.tick(time)).status).toBe('failed');
    expect(a.currents.fetchPage).toHaveBeenCalledTimes(2);
    expect(count(s, 'news_quota_reservations')).toBe(2);
    expect(s.get('news_provider:currents', {})).toMatchObject({ nextAt: time + 120000 });
    expect(JSON.stringify(s.db.prepare('SELECT * FROM news_queries').all())).not.toContain(
      'private-key',
    );
    expect(JSON.stringify(s.get('news_last_result', {}))).not.toContain('private-key');
  } finally {
    s.close();
  }
});
it('suspends malformed queries and permits other queries on a later tick', async () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    approve(n, 'gdelt');
    n.saveConfig({ enabled: true, providers: { gdelt: true } });
    let time = now;
    const a = adapters(async () => {
      throw new NewsError('NEWS_INVALID_QUERY');
    });
    const ingestion = new NewsIngestion(n, {}, () => time, undefined, a);
    await ingestion.tick(time);
    expect(count(s, 'news_queries')).toBe(2);
    expect(
      (
        s.db.prepare("SELECT COUNT(*) AS n FROM news_queries WHERE status='suspended'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    time += 60000;
    await ingestion.tick(time);
    expect(a.gdelt.fetchPage).toHaveBeenCalledTimes(2);
  } finally {
    s.close();
  }
});
it('leases survive restarts and count a crashed attempt without resending it', () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    approve(n, 'gdelt');
    n.saveConfig({ enabled: true, providers: { gdelt: true } });
    const scheduler = new NewsScheduler(n),
      config = n.config();
    scheduler.reconcile(now, config);
    const first = scheduler.claim(now, config, { gdelt: true });
    expect(first).not.toBeNull();
    const restarted = new NewsScheduler(new NewsStore(s, now));
    expect(restarted.claim(now + 1000, config, { gdelt: true })).toBeNull();
    expect(restarted.claim(now + 30000, config, { gdelt: true })).toBeNull();
    const next = restarted.claim(now + 7200000, config, { gdelt: true });
    expect(next).not.toBeNull();
    expect(next?.attemptId).not.toBe(first?.attemptId);
    expect(count(s, 'news_quota_reservations')).toBe(2);
  } finally {
    s.close();
  }
});
it('generates watchlist symbol queries and reviewed alias queries without guessing issuer names', () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    s.pin(equity('TEST'));
    s.pin(equity('CAT'));
    const instrument = equity('TEST');
    n.saveAlias({
      id: 'test-alias',
      instrumentId: instrument.id,
      alias: 'Test Company',
      venue: 'NASDAQ',
      reviewedAt: now - 1000,
      expiresAt: now + 86400000,
      evidence: 'Synthetic alias review',
    });
    n.saveConfig({ enabled: true, providers: { marketaux: true, currents: true, gdelt: true } });
    new NewsScheduler(n).reconcile(now, n.config());
    const queries = (
      s.db.prepare('SELECT specification FROM news_queries').all() as { specification: string }[]
    ).map((r) => JSON.parse(r.specification) as NewsQuery);
    expect(queries.some((q) => q.provider === 'marketaux' && q.symbols.includes('CAT'))).toBe(true);
    expect(queries.some((q) => q.provider === 'currents' && q.terms.includes('Test Company'))).toBe(
      true,
    );
    expect(queries.some((q) => q.provider === 'gdelt' && q.terms.includes('CAT'))).toBe(false);
    expect(queries.length).toBeLessThanOrEqual(64);
    expect(queries.some((q) => q.terms.includes('Federal Reserve'))).toBe(true);
  } finally {
    s.close();
  }
});
it('protects tick time, shared resource headroom, news daily quotas, and object storage', async () => {
  for (const reason of ['time', 'shared', 'news', 'storage'] as const) {
    const s = new Store(':memory:');
    try {
      const n = new NewsStore(s, now);
      approve(n, 'gdelt');
      n.saveConfig({ enabled: true, providers: { gdelt: true } });
      const a = adapters(async (q) => page(q));
      const ingestion = new NewsIngestion(n, {}, () => now, undefined, a);
      if (reason === 'news')
        s.set('news_resource_usage', { day: '2026-10-09', reads: 100000, writes: 0 });
      const result = await ingestion.tick(reason === 'time' ? now - 45000 : now, () => ({
        reads: reason === 'shared' ? 3200000 : 0,
        writes: 0,
        storageBytes: reason === 'storage' ? 800000000 : 0,
      }));
      expect(result.status).toBe('skipped');
      expect(a.gdelt.fetchPage).not.toHaveBeenCalled();
    } finally {
      s.close();
    }
  }
});
it('contains arbitrary adapter errors in news diagnostics without leaking secrets or resetting market state', async () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    approve(n, 'gdelt');
    n.saveConfig({ enabled: true, providers: { gdelt: true } });
    s.set('last_error', 'OLD_MARKET_ERROR');
    s.set('soak_start', now - 1000);
    const a = adapters(async () => {
      throw new Error('URL contained private-key');
    });
    const result = await new NewsIngestion(n, {}, () => now, undefined, a).tick(now);
    expect(result.diagnostic).toBe('NEWS_INVALID_RESPONSE');
    expect(JSON.stringify(s.get('news_last_result', {}))).not.toContain('private-key');
    expect(s.get('last_error', '')).toBe('OLD_MARKET_ERROR');
    expect(s.get('soak_start', 0)).toBe(now - 1000);
  } finally {
    s.close();
  }
});
it('suspends a malformed persisted recipe without blocking other licensed queries', async () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    approve(n, 'gdelt');
    n.saveConfig({ enabled: true, providers: { gdelt: true } });
    const scheduler = new NewsScheduler(n);
    scheduler.reconcile(now, n.config());
    const first = s.db.prepare('SELECT id FROM news_queries ORDER BY id LIMIT 1').get() as {
      id: string;
    };
    s.db
      .prepare('UPDATE news_queries SET specification=? WHERE id=?')
      .run('invalid JSON', first.id);
    const a = adapters(async (q) => page(q));
    expect((await new NewsIngestion(n, {}, () => now, undefined, a).tick(now)).status).toBe(
      'complete',
    );
    expect(s.db.prepare('SELECT status FROM news_queries WHERE id=?').get(first.id)).toEqual({
      status: 'suspended',
    });
    expect(a.gdelt.fetchPage).toHaveBeenCalledTimes(1);
    expect(count(s, 'news_quota_reservations')).toBe(1);
  } finally {
    s.close();
  }
});
it('runs local analysis on idle ticks and contains failures without changing market state', async () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    n.saveConfig({ enabled: true });
    s.set('last_error', 'MARKET_UNCHANGED');
    s.set('soak_start', now - 1000);
    const ingestion = new NewsIngestion(n, {}, () => now);
    const analyze = vi.spyOn(ingestion.intelligence, 'process').mockImplementation(() => {
      throw new Error('secret-fixture');
    });
    expect((await ingestion.tick(now)).status).toBe('idle');
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(s.get('news_analysis_error', '')).toBe('NEWS_ANALYSIS_FAILED');
    expect(s.get('last_error', '')).toBe('MARKET_UNCHANGED');
    expect(s.get('soak_start', 0)).toBe(now - 1000);
  } finally {
    s.close();
  }
});
it('includes current-tick SQL work in the analysis daily resource guard', async () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    n.saveConfig({ enabled: true });
    s.set('news_resource_usage', { day: '2026-10-09', reads: 99990, writes: 0 });
    const ingestion = new NewsIngestion(n, {}, () => now);
    let reads = 0;
    const analyze = vi
      .spyOn(ingestion.intelligence, 'process')
      .mockImplementation((_now, canWork) => {
        expect(canWork!()).toBe(true);
        reads = 20;
        expect(canWork!()).toBe(false);
        return { processed: 0, unchanged: 0, failed: 0 };
      });
    expect((await ingestion.tick(now, () => ({ reads, writes: 0, storageBytes: 0 }))).status).toBe(
      'idle',
    );
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(s.get('news_resource_usage', { reads: 0 }).reads).toBe(100010);
  } finally {
    s.close();
  }
});
it('accounts publication work using monotonic counters despite shared-budget resets', async () => {
  const s = new Store(':memory:');
  try {
    const n = new NewsStore(s, now);
    n.saveConfig({ enabled: true });
    const ingestion = new NewsIngestion(n, {}, () => now);
    let reads = 50,
      unaccountedReads = 50;
    await ingestion.publicationWork(
      now,
      () => ({ reads, writes: 0, unaccountedReads, unaccountedWrites: 0, storageBytes: 0 }),
      async (canWork) => {
        expect(canWork()).toBe(true);
        reads += 20;
        unaccountedReads = 0;
        expect(canWork()).toBe(true);
      },
    );
    expect(s.get('news_resource_usage', { reads: 0 }).reads).toBe(20);
  } finally {
    s.close();
  }
});
