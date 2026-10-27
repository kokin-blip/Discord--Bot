import { NewsMonitor } from './monitor.js';
import { recoverSmoke } from './smoke.js';
import { newsId, publisherDomain } from './normalize.js';
import { NEWS_LIMITS } from './config.js';
import { NewsScheduler } from './scheduler.js';
import { NewsTransport, NewsError, newsDiagnostic } from './transport.js';
import { MarketauxNews } from './providers/marketaux.js';
import { CurrentsNews } from './providers/currents.js';
import { GdeltNews } from './providers/gdelt.js';
import type { NewsStore } from './store.js';
import type { NewsAdapter, NewsProvider } from './types.js';
import { pageSchema } from './validation.js';
import { NewsIntelligence } from './intelligence.js';
export interface NewsSecrets {
  MARKETAUX_API_TOKEN?: string;
  CURRENTS_API_KEY?: string;
}
export interface NewsMeter {
  reads: number;
  writes: number;
  storageBytes: number;
  unaccountedReads?: number;
  unaccountedWrites?: number;
}
export type NewsTickResult = {
  status: 'disabled' | 'skipped' | 'idle' | 'complete' | 'failed';
  diagnostic: string | null;
};
export class NewsIngestion {
  readonly scheduler: NewsScheduler;
  readonly monitor: NewsMonitor;
  readonly origin: 'live' | 'synthetic';
  readonly intelligence: NewsIntelligence;
  readonly adapters: Record<NewsProvider, NewsAdapter>;
  private running = false;
  private activeMeter: NewsMeter | null = null;
  constructor(
    readonly news: NewsStore,
    private readonly secrets: NewsSecrets,
    readonly clock: () => number = Date.now,
    transport = new NewsTransport(fetch, clock),
    adapters?: Record<NewsProvider, NewsAdapter>,
  ) {
    this.scheduler = new NewsScheduler(news);
    this.monitor = new NewsMonitor(news);
    this.origin = adapters ? 'synthetic' : 'live';
    this.intelligence = new NewsIntelligence(news);
    this.adapters = adapters ?? {
      marketaux: new MarketauxNews(secrets.MARKETAUX_API_TOKEN ?? '', transport),
      currents: new CurrentsNews(secrets.CURRENTS_API_KEY ?? '', transport),
      gdelt: new GdeltNews(transport),
    };
  }
  private resources(now: number, meter: NewsMeter): boolean {
    const store = this.news.store,
      day = new Date(now).toISOString().slice(0, 10);
    const usage = store.get('news_resource_usage', { day, reads: 0, writes: 0 });
    const shared = store.get('cloud_usage', { day, reads: 0, writes: 0, requests: 0 });
    const reads = Math.max(0, meter.reads - (this.activeMeter?.reads ?? meter.reads));
    const writes = Math.max(0, meter.writes - (this.activeMeter?.writes ?? meter.writes));
    return (
      (usage.day !== day ||
        (usage.reads + reads < NEWS_LIMITS.dailyReads &&
          usage.writes + writes < NEWS_LIMITS.dailyWrites)) &&
      (shared.day !== day ||
        (shared.reads + (meter.unaccountedReads ?? meter.reads) < 3200000 &&
          shared.writes + (meter.unaccountedWrites ?? meter.writes) < 64000 &&
          shared.requests < 64000)) &&
      meter.storageBytes < NEWS_LIMITS.objectStorageBytes
    );
  }
  private storageEstimate(now: number): number {
    const store = this.news.store,
      day = new Date(now).toISOString().slice(0, 10);
    let estimate = store.get('news_storage_estimate', { day: '', bytes: 0 });
    if (estimate.day !== day) {
      // One bounded-size audit/day; incremental inserts conservatively add overhead.
      const row = store.db
        .prepare(
          `SELECT
        (SELECT COALESCE(SUM(length(CAST(body AS BLOB))*4+2048),0) FROM news_observations) +
        (SELECT COALESCE(SUM(length(CAST(url AS BLOB))*4+2048),0) FROM news_articles) +
        (SELECT COALESCE(SUM(length(CAST(body AS BLOB))*4+2048),0) FROM news_source_policies) +
        (SELECT COALESCE(SUM(length(CAST(body AS BLOB))*4+2048),0) FROM news_aliases) +
        (SELECT COALESCE(SUM(length(CAST(specification AS BLOB))*4+2048),0) FROM news_queries) +
        (SELECT COUNT(*)*1024 FROM news_quota_reservations) +
        (SELECT COALESCE(SUM(length(CAST(body AS BLOB))*4+2048),0) FROM news_events) +
        (SELECT COALESCE(SUM(length(CAST(body AS BLOB))*4+1024),0) FROM news_sentiments) +
        (SELECT COALESCE(SUM(length(CAST(evidence AS BLOB))*4+1024),0) FROM news_instrument_links) +
        (SELECT COUNT(*)*1024 FROM news_analysis_state) +
        (SELECT COUNT(*)*1024 FROM news_analysis_queue) +
        (SELECT COALESCE(SUM(length(CAST(body AS BLOB))*4+1024),0) FROM news_publisher_groups) +
        (SELECT COUNT(*)*4096 FROM news_deliveries) +
        (SELECT COALESCE(SUM(length(CAST(policy_versions AS BLOB))*4+2048),0) FROM news_delivery_items) +
        (SELECT COALESCE(SUM(length(CAST(body AS BLOB))*4+1024),0) FROM news_monitor_days) +
        (SELECT COUNT(*)*2048 FROM news_smoke_requests) + (SELECT COUNT(*)*2048 FROM news_smoke_jobs) AS bytes`,
        )
        .get() as { bytes: number };
      estimate = { day, bytes: row.bytes };
      store.set('news_storage_estimate', estimate);
    }
    return estimate.bytes;
  }
  private analyze(startedAt: number, getMeter: () => NewsMeter): void {
    try {
      const result = this.intelligence.process(
        this.clock(),
        () => this.clock() - startedAt < 55000 && this.resources(this.clock(), getMeter()),
      );
      this.news.store.set('news_analysis_error', result.failed ? 'NEWS_ANALYSIS_FAILED' : null);
    } catch {
      try {
        this.news.store.set('news_analysis_error', 'NEWS_ANALYSIS_FAILED');
      } catch {}
    }
  }
  private account(start: NewsMeter, startedAt: number, getMeter: () => NewsMeter): void {
    const now = this.clock(),
      day = new Date(now).toISOString().slice(0, 10),
      store = this.news.store;
    const usage = store.get('news_resource_usage', { day, reads: 0, writes: 0, maxTickMs: 0 });
    const end = getMeter();
    const reads = (usage.day === day ? usage.reads : 0) + Math.max(0, end.reads - start.reads);
    const writes = (usage.day === day ? usage.writes : 0) + Math.max(0, end.writes - start.writes);
    const maxTickMs = Math.max(usage.day === day ? (usage.maxTickMs ?? 0) : 0, now - startedAt);
    // Resource guards persist every work unit. Dashboard aggregates flush every five minutes,
    // avoiding several thousand otherwise redundant indexed writes per day.
    const last = store.get('news_metric_usage', { at: 0, day: '', reads: 0, writes: 0 });
    if (last.day !== day || now - last.at >= 300000) {
      this.monitor.count(now, {
        reads: Math.max(0, reads - (last.day === day ? last.reads : 0)),
        writes: Math.max(0, writes - (last.day === day ? last.writes : 0)),
        maxTickMs,
      });
      store.set('news_metric_usage', { at: now, day, reads, writes });
    }
    const accounted = getMeter();
    store.set('news_resource_usage', {
      day,
      reads:
        (usage.day === day ? usage.reads : 0) +
        Math.max(0, Math.max(end.reads, accounted.reads) - start.reads),
      writes:
        (usage.day === day ? usage.writes : 0) +
        Math.max(0, Math.max(end.writes, accounted.writes) - start.writes) +
        2,
      maxTickMs,
    });
  }
  /** Account publication SQL separately from ingestion, sharing the same news limits. */
  async publicationWork(
    startedAt: number,
    getMeter: () => NewsMeter,
    work: (canWork: () => boolean) => Promise<void>,
  ): Promise<void> {
    if (this.running || !this.news.config().enabled) return;
    const start = getMeter();
    this.running = true;
    this.activeMeter = start;
    const canWork = () =>
      this.clock() - startedAt < 45000 &&
      !this.news.store.settings().paused &&
      this.resources(this.clock(), getMeter()) &&
      this.news.store.get('news_storage_estimate', { bytes: 0 }).bytes < NEWS_LIMITS.storageBytes;
    try {
      if (canWork()) await work(canWork);
    } finally {
      try {
        this.account(start, startedAt, getMeter);
      } finally {
        this.activeMeter = null;
        this.running = false;
      }
    }
  }

  async tick(
    startedAt: number,
    getMeter: () => NewsMeter = () => ({ reads: 0, writes: 0, storageBytes: 0 }),
  ): Promise<NewsTickResult> {
    const startMeter = getMeter(),
      store = this.news.store;
    let track = false;
    if (this.running) return { status: 'skipped', diagnostic: null };
    this.running = true;
    this.activeMeter = startMeter;
    try {
      const config = this.news.config();
      if (!config.enabled) return { status: 'disabled', diagnostic: null };
      track = true;
      const now = this.clock(),
        day = new Date(now).toISOString().slice(0, 10);
      if (store.settings().paused || now - startedAt >= 45000 || !this.resources(now, getMeter()))
        return { status: 'skipped', diagnostic: 'NEWS_RESOURCE_PAUSED' };
      const reconciled = store.get('news_reconciled', { at: 0, config: '' }),
        signature = newsId(config.providers);
      if (now - reconciled.at >= 3600000 || reconciled.config !== signature) {
        this.scheduler.reconcile(now, config);
        store.set('news_reconciled', { at: now, config: signature });
      }
      if (now - store.get('news_maintenance_at', 0) >= 3600000) {
        this.news.cleanup(now);
        store.db
          .prepare(
            'DELETE FROM news_quota_reservations WHERE id IN (SELECT id FROM news_quota_reservations WHERE reserved_at<? LIMIT 100)',
          )
          .run(now - 90 * 86400000);
        store.db
          .prepare('DELETE FROM news_quota_days WHERE day<?')
          .run(new Date(now - 365 * 86400000).toISOString().slice(0, 10));
        store.set('news_maintenance_at', now);
      }
      if (
        !this.resources(now, getMeter()) ||
        this.storageEstimate(now) >= NEWS_LIMITS.storageBytes ||
        store.get('news_storage_full_day', '') === day ||
        now - startedAt >= 45000
      )
        return { status: 'skipped', diagnostic: 'NEWS_RESOURCE_PAUSED' };
      const available = {
        marketaux: Boolean(this.secrets.MARKETAUX_API_TOKEN?.trim()),
        currents: Boolean(this.secrets.CURRENTS_API_KEY?.trim()),
        gdelt: true,
      };
      for (const provider of ['marketaux', 'currents', 'gdelt'] as const)
        if (config.providers[provider])
          this.scheduler.quota.credential(
            provider,
            newsId(
              provider,
              provider === 'marketaux'
                ? this.secrets.MARKETAUX_API_TOKEN
                : provider === 'currents'
                  ? this.secrets.CURRENTS_API_KEY
                  : 'public',
            ),
            available[provider],
          );
      // Retired private-test work must never be promoted into live publication.
      if (this.origin === 'live')
        store.db
          .prepare(
            "UPDATE news_smoke_jobs SET status='skipped',diagnostic='NEWS_TEST_RETIRED' WHERE status IN ('pending','attempted')",
          )
          .run();
      recoverSmoke(this.news, now);
      this.monitor.maintenance(now);
      const claimed = this.scheduler.claim(now, config, available);
      if (!claimed) {
        this.analyze(startedAt, getMeter);
        return { status: 'idle', diagnostic: null };
      }
      const { row, query, attemptId } = claimed;
      let error: NewsError | null = null;
      let quota = null;
      let checkpoint = null;
      let stored = 0,
        suppressed = 0,
        duplicates = 0;
      try {
        const page = pageSchema.parse(
          await this.adapters[row.provider].fetchPage(query, new AbortController().signal),
        );
        quota = page.quota;
        for (const raw of page.observations) {
          if (!this.resources(this.clock(), getMeter())) throw new NewsError('NEWS_STORAGE_LIMIT');
          // Provider filters are not trusted as a substitute for source policies.
          if (
            raw.provider !== row.provider ||
            raw.language !== 'en' ||
            !query.domains.includes(publisherDomain(raw.url))
          ) {
            suppressed++;
            continue;
          }
          try {
            const result = this.news.saveObservation(
              { ...raw, queryId: query.id, attemptId },
              this.clock(),
            );
            if (result.duplicate || result.canonicalDuplicate) duplicates++;
            if (!result.duplicate) stored++;
          } catch (failure) {
            const code = newsDiagnostic(failure);
            if (
              code === 'NEWS_STORAGE_DENIED' ||
              code === 'NEWS_RETENTION_EXPIRED' ||
              code === 'NEWS_IDENTITY_CONFLICT'
            ) {
              suppressed++;
              continue;
            }
            throw new NewsError(code === 'NEWS_STORAGE_LIMIT' ? code : 'NEWS_STORAGE_FAILED');
          }
        }
        checkpoint = {
          through: query.endAt,
          truncated: page.pagination.truncated,
          stored,
          suppressed,
          duplicates,
        };
      } catch (failure) {
        error = failure instanceof NewsError ? failure : new NewsError('NEWS_INVALID_RESPONSE');
        if (error.code === 'NEWS_STORAGE_LIMIT') store.set('news_storage_full_day', day);
      }
      const finished = this.clock();
      store.transaction(() => {
        this.scheduler.quota.complete(
          row.provider,
          attemptId,
          finished,
          quota,
          error,
          row.failures,
        );
        this.scheduler.finish(row, attemptId, finished, checkpoint, error);
        this.monitor.count(finished, { stored, duplicates, policySuppressed: suppressed });
        if (!error) this.monitor.success(row.provider, finished, this.origin);
        store.set('news_runtime_error', null);
        store.set('news_last_result', {
          at: finished,
          provider: row.provider,
          diagnostic: error?.code ?? null,
          ...checkpoint,
        });
      });
      this.analyze(startedAt, getMeter);
      return { status: error ? 'failed' : 'complete', diagnostic: error?.code ?? null };
    } catch (error) {
      // No raw errors, URLs or provider bodies escape into the market error/soak state.
      const diagnostic = newsDiagnostic(error);
      try {
        store.set('news_runtime_error', diagnostic);
      } catch {
        /* Market remains operational even if news persistence fails. */
      }
      return { status: 'failed', diagnostic };
    } finally {
      this.running = false;
      this.activeMeter = null;
      if (track) {
        try {
          this.account(startMeter, startedAt, getMeter);
        } catch {
          /* Do not propagate news accounting failures to market scans. */
        }
      }
    }
  }
}
