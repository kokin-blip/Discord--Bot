import { expect, it, vi } from 'vitest';
import { NewsMonitor } from '../src/news/monitor.js';
import { NewsQuota } from '../src/news/quota.js';
import { newsFixture } from './news-publication-fixtures.js';
import { now, policy } from './news-fixtures.js';
const day = 86400000;
function healthy(monitor: NewsMonitor, at: number, origin: 'live' | 'synthetic' = 'live') {
  for (const provider of ['marketaux', 'currents', 'gdelt'] as const)
    monitor.success(provider, at, origin);
  monitor.observe(at, 'test', true);
}
function mature(f: ReturnType<typeof newsFixture>, monitor: NewsMonitor) {
  // Current health is sufficient; no private channel or seven-day loop is required.
  healthy(monitor, now + 7 * day);
  monitor.count(now + 7 * day, { mapped: 10, alerts: 1 });
}
function review(monitor: NewsMonitor, at: number) {
  return {
    sha256: monitor.snapshot(at).sha256,
    reviewedMappings: 10,
    falseMappings: 0,
    reviewedAlerts: 1,
    falseAlerts: 0,
    freePlanVerified: true,
  };
}
it('requires a current manager review and live health without a private channel or soak', () => {
  const f = newsFixture(),
    monitor = new NewsMonitor(f.news);
  try {
    f.store.set('news_soak_start', now - 8 * day);
    f.store.set('news_healthy_at', now);
    f.store.set('news_production_approved', true);
    f.store.set('news_runtime_healthy_at', 0);
    expect(monitor.blockers(now)).toEqual([
      'NEWS_ROLLOUT_REVIEW_REQUIRED',
      'NEWS_RUNTIME_HEALTH_REQUIRED',
    ]);
    healthy(monitor, now, 'synthetic');
    expect(monitor.blockers(now)).toContain('NEWS_RUNTIME_HEALTH_REQUIRED');
    healthy(monitor, now);
    monitor.count(now, { mapped: 10 });
    expect(() => monitor.approve(review(monitor, now), 'manager', now)).not.toThrow();
    expect(monitor.blockers(now)).toEqual([]);
    f.add();
    f.publication.queue(now);
    const event = f.pending()[0]!.event;
    f.publication.delivered(event, now);
    expect(monitor.totals(now).privateDeliveries).toBe(0); // a pending row alone is not delivery evidence
    const second = f.add(
      {
        providerArticleId: 'second',
        url: 'https://publisher.example/second',
        headline: 'Test Company confirmed a material data breach',
      },
      now + 60000,
    );
    expect(second).toBeTruthy();
    f.publication.queue(now + 60000);
    const actual = f.pending().find((p) => p.event.id !== event.id)!.event;
    f.store.saveReceipt(actual.id, 'public', 'message');
    f.publication.delivered(actual, now + 60000);
    f.publication.delivered(actual, now + 60000);
    expect(monitor.totals(now + 60000)).toMatchObject({
      privateDeliveries: 0,
      alerts: 1,
      fresh: 1,
    });
  } finally {
    f.store.close();
  }
});
it('rejects bad/stale human reviews and resource overruns; records sample accuracy without strategy promotion', () => {
  const f = newsFixture(),
    monitor = new NewsMonitor(f.news);
  try {
    const strategy = f.store.strategy();
    mature(f, monitor);
    const at = now + 7 * day,
      r = review(monitor, at);
    for (const value of [
      { ...r, falseMappings: 1 },
      { ...r, falseAlerts: 1 },
      { ...r, reviewedAlerts: 0 },
      { ...r, sha256: 'b'.repeat(64) },
    ])
      expect(() => monitor.approve(value, 'manager', at)).toThrow('NEWS_ROLLOUT_REVIEW_BLOCKED');
    expect(() => monitor.approve({ ...r, freePlanVerified: false }, 'manager', at)).toThrow();
    expect(() => monitor.approve(r, 'manager', at + 3600001)).toThrow(
      'NEWS_ROLLOUT_REVIEW_BLOCKED',
    );
    monitor.count(at, { maxTickMs: 55000 });
    expect(monitor.blockers(at)).toContain('NEWS_RESOURCE_REVIEW_REQUIRED');
    expect(f.store.strategy()).toEqual(strategy);
  } finally {
    f.store.close();
  }
});
it('requires ongoing live health and invalidates review on configuration changes', () => {
  const f = newsFixture(),
    monitor = new NewsMonitor(f.news);
  try {
    mature(f, monitor);
    const at = now + 7 * day;
    monitor.approve(review(monitor, at), 'manager', at);
    for (let time = at + 600000; time <= at + day; time += 600000) {
      for (const p of ['marketaux', 'currents', 'gdelt'] as const) monitor.success(p, time, 'live');
      monitor.observe(time, 'production', true);
    }
    expect(monitor.blockers(at + day)).toEqual([]);
    expect(monitor.blockers(at + day + 600001)).toContain('NEWS_RUNTIME_HEALTH_REQUIRED');
    monitor.observe(at + day + 600001, 'production', false);
    expect(monitor.blockers(at + day + 600001)).toContain('NEWS_ROLLOUT_REVIEW_REQUIRED');
    expect(f.store.get('soak_start', 123)).toBe(123);
    mature(f, monitor);
    healthy(monitor, at + 600001);
    expect(monitor.report(at + 600001).soak.start).toBe(0);
    mature(f, monitor);
    f.news.saveConfig({ ...f.news.config(), alerts: false });
    expect(monitor.blockers(at)).toContain('NEWS_ROLLOUT_REVIEW_REQUIRED');
  } finally {
    f.store.close();
  }
});
it('counts finite operational metrics, policy suppression and failures without content, and bounds retention', () => {
  // Policy suppression uses the runtime clock; keep it on the fixture day for retention assertions.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const f = newsFixture(),
    monitor = new NewsMonitor(f.news);
  try {
    monitor.count(now, { duplicates: 2, policySuppressed: 3, unknown: 1 });
    monitor.count(now, { duplicates: 1, maxTickMs: 8 });
    monitor.count(now, { maxTickMs: 3 });
    const quota = new NewsQuota(f.news);
    quota.reserve('gdelt', 'query', 'attempt', now, 30);
    quota.reserve('gdelt', 'query', 'attempt', now, 30);
    expect(monitor.totals(now)).toMatchObject({
      duplicates: 3,
      policySuppressed: 3,
      unknown: 1,
      maxTickMs: 8,
      attempts: 1,
    });
    expect(() => monitor.count(now, { reads: NaN })).toThrow('NEWS_INVALID_METRIC');
    f.add();
    f.publication.queue(now);
    expect(f.pending()).toHaveLength(1);
    f.news.savePolicy({ ...policy('publisher'), version: 2, status: 'revoked' });
    expect(f.pending()).toHaveLength(0);
    f.publication.failed(now);
    expect(monitor.totals(now).deliveryFailures).toBe(1);
    expect(JSON.stringify(monitor.report(now))).not.toContain('Test Company');
    monitor.maintenance(now + 91 * day);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM news_monitor_days').get()).toEqual({
      n: 0,
    });
  } finally {
    clock.mockRestore();
    f.store.close();
  }
});
