import { NewsMonitor } from '../src/news/monitor.js';
import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.js';
import { NewsStore } from '../src/news/store.js';
import { NewsScheduler } from '../src/news/scheduler.js';
import { recoverSmoke, requestNewsSmoke, smokeStatus } from '../src/news/smoke.js';
import { syntheticNewsSmoke } from '../scripts/news-smoke.js';
import { syntheticNewsPolicy, fixtureTime as now } from '../src/research/news-fixtures.js';
it('runs all real adapters with synthetic transport through shared quotas and never grants live health', async () => {
  const result = await syntheticNewsSmoke();
  expect(result).toMatchObject({
    liveCalls: 0,
    calls: 3,
    productionEligible: false,
    metrics: { attempts: 3, stored: 3, duplicates: 2 },
  });
  expect(result.jobs).toHaveLength(3);
  expect(JSON.stringify(result)).not.toContain('synthetic-only');
});
it('persists uncertain smoke attempts across restart, counts quota and never retries that job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-smoke-')),
    path = join(dir, 'state.sqlite');
  let store = new Store(path);
  try {
    let news = new NewsStore(store, now);
    news.saveConfig({ enabled: true, providers: { gdelt: true } });
    for (const scope of ['provider', 'publisher'] as const)
      news.savePolicy(syntheticNewsPolicy(scope, 'gdelt'));
    expect(() => requestNewsSmoke(news, 'bad', now, 'production')).toThrow(
      'NEWS_SMOKE_TEST_MODE_REQUIRED',
    );
    expect(requestNewsSmoke(news, 'one', now, 'test')).toEqual(['gdelt']);
    expect(requestNewsSmoke(news, 'one', now, 'test')).toEqual([]);
    expect(() => requestNewsSmoke(news, 'two', now, 'test')).toThrow('NEWS_SMOKE_PENDING');
    const scheduler = new NewsScheduler(news);
    scheduler.reconcile(now, news.config());
    const claimed = scheduler.claim(now, news.config(), {
      marketaux: false,
      currents: false,
      gdelt: true,
    })!;
    expect(claimed).toBeTruthy();
    store.close();
    store = new Store(path);
    news = new NewsStore(store, now + 60000);
    expect(new NewsMonitor(news).totals(now + 60000).attempts).toBe(1);
    recoverSmoke(news, now + 60000);
    expect(smokeStatus(news)).toEqual([
      expect.objectContaining({ status: 'uncertain', attempt_id: claimed.attemptId }),
    ]);
    expect(store.db.prepare('SELECT attempts FROM news_quota_days').get()).toEqual(
      expect.objectContaining({ attempts: 1 }),
    );
    expect(
      new NewsScheduler(news).claim(now + 60000, news.config(), {
        marketaux: false,
        currents: false,
        gdelt: true,
      }),
    ).toBeNull();
    expect(store.db.prepare('SELECT status FROM news_quota_reservations').get()).toEqual(
      expect.objectContaining({ status: 'reserved' }),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('denies unknown rights, skips missing credentials and expires blocked jobs without attempts', () => {
  const store = new Store(':memory:');
  try {
    const news = new NewsStore(store, now);
    news.saveConfig({ enabled: true, providers: { marketaux: true } });
    expect(() => requestNewsSmoke(news, 'no-rights', now, 'test')).toThrow('NEWS_STORAGE_DENIED');
    for (const scope of ['provider', 'publisher'] as const)
      news.savePolicy(syntheticNewsPolicy(scope, 'marketaux'));
    requestNewsSmoke(news, 'missing', now, 'test');
    const scheduler = new NewsScheduler(news);
    scheduler.reconcile(now, news.config());
    expect(
      scheduler.claim(now, news.config(), { marketaux: false, currents: false, gdelt: true }),
    ).toBeNull();
    expect(smokeStatus(news)).toEqual([
      expect.objectContaining({ status: 'skipped', diagnostic: 'NEWS_CREDENTIAL_MISSING' }),
    ]);
    requestNewsSmoke(news, 'expired', now, 'test');
    recoverSmoke(news, now + 86400000);
    expect(smokeStatus(news)).toContainEqual(
      expect.objectContaining({ status: 'skipped', diagnostic: 'NEWS_SMOKE_EXPIRED' }),
    );
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM news_quota_reservations').get()).toEqual({
      n: 0,
    });
  } finally {
    store.close();
  }
});
