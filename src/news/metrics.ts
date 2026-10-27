import type { NewsStore } from './store.js';
export const metricNames = [
  'attempts',
  'failures',
  'retries',
  'stored',
  'duplicates',
  'policySuppressed',
  'analyzed',
  'unmapped',
  'mapped',
  'analysisFailures',
  'publicationSuppressed',
  'deliveryFailures',
  'privateDeliveries',
  'alerts',
  'digests',
  'fresh',
  'stale',
  'unknown',
  'future',
  'reads',
  'writes',
  'maxTickMs',
] as const;
export type NewsMetric = (typeof metricNames)[number];
export type NewsMetrics = Record<NewsMetric, number>;
export const emptyNewsMetrics = (): NewsMetrics =>
  Object.fromEntries(metricNames.map((key) => [key, 0])) as NewsMetrics;
export function countNewsMetrics(news: NewsStore, now: number, delta: Partial<NewsMetrics>): void {
  const day = new Date(now).toISOString().slice(0, 10),
    store = news.store;
  store.transaction(() => {
    const row = store.db.prepare('SELECT body FROM news_monitor_days WHERE day=?').get(day) as
      { body: string } | undefined;
    const metrics = { ...emptyNewsMetrics(), ...(row ? JSON.parse(row.body) : {}) } as NewsMetrics;
    for (const key of metricNames) {
      const value = delta[key] ?? 0;
      if (!Number.isFinite(value) || value < 0) throw new Error('NEWS_INVALID_METRIC');
      metrics[key] = key === 'maxTickMs' ? Math.max(metrics[key], value) : metrics[key] + value;
    }
    store.db
      .prepare(
        'INSERT INTO news_monitor_days VALUES(?,?) ON CONFLICT(day) DO UPDATE SET body=excluded.body',
      )
      .run(day, JSON.stringify(metrics));
  });
}
