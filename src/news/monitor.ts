import { z } from 'zod';
import { NEWS_ANALYTICS_VERSION } from './mapping.js';
import { NEWS_LIMITS } from './config.js';
import { newsId } from './normalize.js';
import { NewsQuota } from './quota.js';
import { approvedDomains } from './scheduler.js';
import { permitted } from './policies.js';
import type { NewsStore } from './store.js';
import type { NewsProvider } from './types.js';
import { metricNames, emptyNewsMetrics, countNewsMetrics, type NewsMetrics } from './metrics.js';
type Metrics = NewsMetrics;
const empty = emptyNewsMetrics;
interface Soak {
  signature: string;
  start: number;
  lastHealthy: number;
  privateAt: number;
}
const blank = (signature = ''): Soak => ({ signature, start: 0, lastHealthy: 0, privateAt: 0 });
export const reviewSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedMappings: z.number().int().positive().max(1000000),
    falseMappings: z.number().int().nonnegative(),
    reviewedAlerts: z.number().int().nonnegative().max(1000000),
    falseAlerts: z.number().int().nonnegative(),
    freePlanVerified: z.literal(true),
  })
  .strict()
  .refine((r) => r.falseMappings <= r.reviewedMappings && r.falseAlerts <= r.reviewedAlerts);
export class NewsMonitor {
  constructor(readonly news: NewsStore) {}
  signature(now: number): string {
    const latest = new Map<string, ReturnType<NewsStore['policies']>[number]>();
    for (const p of this.news.policies()) {
      const key = `${p.provider}:${p.scope}:${p.publisherDomain}`;
      if ((latest.get(key)?.version ?? 0) < p.version) latest.set(key, p);
    }
    return newsId(
      NEWS_ANALYTICS_VERSION,
      this.news.config(),
      [...latest.values()].sort((a, b) => a.id.localeCompare(b.id)),
      this.news.aliases(now),
      this.news.publisherGroups(now),
    );
  }
  count(now: number, delta: Partial<Metrics>): void {
    countNewsMetrics(this.news, now, delta);
  }
  totals(now: number): Metrics {
    const start = new Date(now - 7 * 86400000).toISOString().slice(0, 10),
      end = new Date(now).toISOString().slice(0, 10);
    const rows = this.news.store.db
      .prepare('SELECT body FROM news_monitor_days WHERE day BETWEEN ? AND ? ORDER BY day')
      .all(start, end) as { body: string }[];
    const totals = empty();
    for (const row of rows) {
      const m = JSON.parse(row.body) as Metrics;
      for (const key of metricNames)
        totals[key] =
          key === 'maxTickMs' ? Math.max(totals[key], m[key] ?? 0) : totals[key] + (m[key] ?? 0);
    }
    return totals;
  }
  success(provider: NewsProvider, now: number, origin: 'live' | 'synthetic'): void {
    if (origin === 'live') this.news.store.set(`news_live_success:${provider}`, now);
  }
  privateDelivery(now: number): void {
    const signature = this.signature(now),
      old = this.news.store.get<Soak>('news_soak_state', blank());
    const state =
      old.signature !== signature || (old.lastHealthy && now - old.lastHealthy > 600000)
        ? blank(signature)
        : old;
    state.privateAt = now;
    this.news.store.set('news_soak_state', state);
  }
  reset(): void {
    if (
      !this.news.store.get<Soak>('news_soak_state', blank()).signature &&
      !this.news.store.get('news_production_approved', false)
    )
      return;
    this.news.store.set('news_soak_state', blank());
    this.news.store.set('news_production_approved', false);
    this.news.store.set('news_soak_start', 0);
    this.news.store.set('news_healthy_at', 0);
    this.news.store.set('news_runtime_healthy_at', 0);
  }
  observe(now: number, _legacyMode: 'test' | 'production', healthy: boolean): void {
    const store = this.news.store,
      config = this.news.config(),
      quota = new NewsQuota(this.news),
      policies = this.news.policies();
    const providers = (['marketaux', 'currents', 'gdelt'] as const).filter(
      (p) => config.providers[p],
    );
    const ready =
      config.enabled &&
      (config.digest || config.alerts) &&
      providers.length > 0 &&
      providers.every((p) => {
        const state = quota.state(p),
          success = store.get(`news_live_success:${p}`, 0);
        return (
          !state.suspended &&
          !state.diagnostic &&
          success > 0 &&
          success <= now &&
          now - success <= 86400000 &&
          approvedDomains(this.news, p, now).some((domain) =>
            ['analyze', 'retainDerived', 'publishMetadata', 'publishDerived'].every((cap) =>
              permitted(policies, p, domain, cap as import('./policies.js').NewsCapability, now),
            ),
          )
        );
      });
    if (!healthy || !ready) this.reset();
    else if (now - store.get('news_runtime_healthy_at', 0) >= 300000)
      store.set('news_runtime_healthy_at', now);
  }

  healthBlockers(now: number, reviewed = false): string[] {
    const metrics = this.totals(now);
    const issues: string[] = [];
    const usage = this.news.store.get('news_resource_usage', { day: '', reads: 0, writes: 0 });
    if (
      metrics.maxTickMs >= 55000 ||
      this.news.store.get('news_resource_usage', { day: '', maxTickMs: 0 }).maxTickMs >= 55000 ||
      (usage.day === new Date(now).toISOString().slice(0, 10) &&
        (usage.reads >= NEWS_LIMITS.dailyReads || usage.writes >= NEWS_LIMITS.dailyWrites)) ||
      this.news.store.get('news_storage_estimate', { bytes: 0 }).bytes >= NEWS_LIMITS.storageBytes
    )
      issues.push('NEWS_RESOURCE_REVIEW_REQUIRED');
    return issues;
  }
  blockers(now: number): string[] {
    const approval = this.news.store.get<{
      signature?: string;
      sha256?: string;
      at?: number;
    } | null>('news_production_approved', null);
    const reviewed =
      !!approval?.sha256 &&
      approval.signature === this.signature(now) &&
      !!approval.at &&
      approval.at <= now;
    const issues = this.healthBlockers(now);
    if (!reviewed) issues.push('NEWS_ROLLOUT_REVIEW_REQUIRED');
    const healthyAt = this.news.store.get('news_runtime_healthy_at', 0);
    if (!healthyAt || healthyAt > now || now - healthyAt > 600000)
      issues.push('NEWS_RUNTIME_HEALTH_REQUIRED');
    return issues;
  }

  report(now: number) {
    const metrics = this.totals(now),
      state = this.news.store.get<Soak>('news_soak_state', blank());
    return {
      analyticsVersion: NEWS_ANALYTICS_VERSION,
      signature: this.signature(now),
      createdAt: now,
      soak: state,
      metrics,
      accuracy: this.news.store.get('news_accuracy_review', null),
      accuracyNote:
        'Accuracy requires a human-labeled sample. Operational counters do not prove correctness or account-wide free capacity.',
      blockers: this.blockers(now),
    };
  }
  snapshot(now: number) {
    const report = this.report(now),
      sha256 = newsId(report);
    const snapshot = { ...report, sha256 };
    this.news.store.set('news_rollout_snapshot', snapshot);
    return snapshot;
  }
  approve(value: unknown, actor: string, now: number): void {
    const review = reviewSchema.parse(value),
      snapshot = this.news.store.get<ReturnType<NewsMonitor['snapshot']> | null>(
        'news_rollout_snapshot',
        null,
      );
    if (
      this.healthBlockers(now).length ||
      !this.news.store.get('news_runtime_healthy_at', 0) ||
      now - this.news.store.get('news_runtime_healthy_at', 0) > 600000 ||
      this.news.store.get('news_runtime_healthy_at', 0) > now ||
      !snapshot ||
      snapshot.sha256 !== review.sha256 ||
      snapshot.signature !== this.signature(now) ||
      snapshot.createdAt > now ||
      now - snapshot.createdAt > 3600000 ||
      (snapshot.metrics.alerts > 0 && review.reviewedAlerts === 0) ||
      snapshot.metrics.mapped === 0 ||
      review.falseMappings > 0 ||
      review.falseAlerts > 0
    )
      throw new Error('NEWS_ROLLOUT_REVIEW_BLOCKED');
    this.news.store.transaction(() => {
      this.news.store.set('news_accuracy_review', {
        ...review,
        actor,
        at: now,
        coverage: 'Human-reviewed sample, not a population accuracy claim.',
      });
      this.news.store.set('news_production_approved', {
        signature: snapshot.signature,
        sha256: review.sha256,
        actor,
        at: now,
      });
    });
  }
  maintenance(now: number): void {
    this.news.store.db
      .prepare(
        'DELETE FROM news_monitor_days WHERE day IN (SELECT day FROM news_monitor_days WHERE day<? ORDER BY day LIMIT 100)',
      )
      .run(new Date(now - 90 * 86400000).toISOString().slice(0, 10));
  }
}
