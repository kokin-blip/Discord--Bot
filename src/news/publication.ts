import { NewsMonitor } from './monitor.js';
import { NEWS_LIMITS } from './config.js';
import { NewsError } from './transport.js';
import { announcement } from '../announcements.js';
import { phoenixDay } from '../daily-recap.js';
import type { SignalEvent } from '../domain.js';
import { newsId } from './normalize.js';
import { permitted, applicablePolicies } from './policies.js';
import { NewsIntelligence } from './intelligence.js';
import { freshness, independentPublishers, type ClusterEvidence } from './clustering.js';
import type { NewsStore } from './store.js';
import type { NewsProvider } from './types.js';
export interface NewsItem {
  articleId: string;
  clusterId: string;
  topic: string;
  eventClass: string;
  severity: string;
  freshness: string;
  publishedAt: number | null;
  firstSeenAt: number | null;
  url: string;
  headline: string | null;
  attribution: string[];
  observations: ClusterEvidence['observations'];
  expiresAt: number;
}
type Delivery = {
  id: string;
  kind: 'digest' | 'alert';
  created_at: number;
  expires_at: number;
  status: string;
};
const midnight = (day: string) => Date.parse(`${day}T00:00:00-07:00`);
export class NewsPublication {
  readonly mode = 'production' as const;
  readonly intelligence: NewsIntelligence;
  constructor(
    readonly news: NewsStore,
    _legacyMode?: 'test' | 'production',
    _legacyTestChannel?: string,
  ) {
    this.intelligence = new NewsIntelligence(news);
  }
  blockers(now: number): string[] {
    return new NewsMonitor(this.news).blockers(now);
  }

  /** Return only metadata explicitly permitted for Discord, including ephemeral responses. */
  items(clusterId: string, now: number): NewsItem[] {
    const config = this.news.config();
    if (!config.enabled) return [];
    const report = this.intelligence.event(clusterId, now);
    if (!report) return [];
    const policies = this.news.policies();
    return report.cluster.evidence.flatMap((e) => {
      if (
        !e.observations.every(
          (ref) =>
            config.providers[ref.provider] &&
            permitted(policies, ref.provider, e.publisherDomain, 'publishMetadata', now) &&
            permitted(policies, ref.provider, e.publisherDomain, 'publishDerived', now),
        )
      )
        return [];
      const observations = e.observations.map((ref) =>
        this.news.observation(ref.provider, ref.providerArticleId, now),
      );
      if (observations.some((o) => !o)) return [];
      const first = observations[0]!;
      const headline =
        observations.find(
          (o) =>
            o?.headline &&
            permitted(policies, o.provider, e.publisherDomain, 'publishHeadline', now),
        )?.headline ?? null;
      const attribution = [
        ...new Set(
          observations
            .flatMap((o) =>
              o
                ? [
                    o.attribution,
                    ...applicablePolicies(policies, o.provider, e.publisherDomain).map(
                      (p) => p.attribution,
                    ),
                  ]
                : [],
            )
            .filter(Boolean),
        ),
      ];
      return [
        {
          articleId: e.articleId,
          clusterId,
          topic: report.cluster.topic,
          eventClass: report.cluster.eventClass,
          severity: e.classification.severity,
          freshness: freshness(e, now),
          publishedAt: e.publishedAt,
          firstSeenAt: e.firstSeenAt,
          url: first.url,
          headline,
          attribution,
          observations: e.observations,
          expiresAt: e.expiresAt,
        },
      ];
    });
  }
  latest(now: number, instrumentId?: string): NewsItem[] {
    const rows = this.news.store.db
      .prepare(
        'SELECT id FROM news_events WHERE expires_at>? AND (? IS NULL OR topic=?) ORDER BY created_at DESC,id LIMIT 25',
      )
      .all(
        now,
        instrumentId ? `instrument:${instrumentId}` : null,
        instrumentId ? `instrument:${instrumentId}` : null,
      ) as { id: string }[];
    return rows.flatMap((row) => this.items(row.id, now).slice(0, 1)).slice(0, 5);
  }
  private alertItems(clusterId: string, now: number): NewsItem[] {
    const report = this.intelligence.event(clusterId, now),
      items = this.items(clusterId, now);
    if (!report || !items.length) return [];
    const allowed = new Set(items.map((i) => i.articleId));
    const evidence = report.cluster.evidence.filter(
      (e) =>
        allowed.has(e.articleId) &&
        !e.classification.uncertain &&
        e.classification.severity === 'high' &&
        freshness(e, now) === 'fresh' &&
        (report.cluster.topic === 'macro:monetary_policy' ||
          (e.mapping && e.mappingConfidence >= 0.8)),
    );
    if (
      !['bankruptcy', 'security_outage', 'legal_regulatory', 'macro_policy'].includes(
        report.cluster.eventClass,
      )
    )
      return [];
    const firstParty = evidence.find(
      (e) =>
        e.publisherGroup?.firstParty &&
        e.publisherGroup.firstPartyTopics?.includes(report.cluster.topic) &&
        e.publisherGroup.reviewedAt <= now &&
        e.publisherGroup.expiresAt > now,
    );
    if (firstParty) return items.filter((i) => i.articleId === firstParty.articleId);
    if (independentPublishers(evidence, now) < 2) return [];
    const first = evidence[0]!,
      second = evidence.find((e) => independentPublishers([first, e], now) === 2);
    return second
      ? items.filter((i) => i.articleId === first.articleId || i.articleId === second.articleId)
      : [];
  }

  private enqueue(id: string, kind: Delivery['kind'], items: NewsItem[], now: number): void {
    const store = this.news.store;
    store.transaction(() => {
      if (store.db.prepare('SELECT id FROM news_deliveries WHERE id=?').get(id)) return;
      // The immutable journal contains only a delivery reference, never article content.
      const event = announcement(newsId('news-journal', id), '', '', now);
      event.kind = 'news_report';
      event.newsReport = { deliveryId: id };
      delete event.announcement;
      event.reasons = [];
      event.candidate.reasons = [];
      event.provenance = { provider: 'Bot', feed: 'News references', delayMinutes: 0, asOf: now };
      store.enqueue(event, kind === 'digest' ? 'summaries' : 'updates');
      store.db
        .prepare('INSERT INTO news_deliveries VALUES(?,?,?,?,?,?)')
        .run(
          id,
          event.id,
          kind,
          now,
          Math.min(
            ...items.map((i) => i.expiresAt),
            kind === 'alert' ? now + 7200000 : now + 86400000,
          ),
          'pending',
        );
      let bytes = 4096;
      for (const item of items) {
        const versions = JSON.stringify(
          item.observations.map((o) => ({ id: o.id, policyVersions: o.policyVersions })),
        );
        bytes += Buffer.byteLength(versions) * 4 + 2048;
        store.db
          .prepare('INSERT INTO news_delivery_items VALUES(?,?,?,?,?)')
          .run(id, item.articleId, item.clusterId, versions, item.expiresAt);
      }
      const estimate = store.get('news_storage_estimate', { day: '', bytes: 0 });
      if (estimate.bytes + bytes >= NEWS_LIMITS.storageBytes)
        throw new NewsError('NEWS_STORAGE_LIMIT');
      store.set('news_storage_estimate', { ...estimate, bytes: estimate.bytes + bytes });
    });
  }
  queue(now: number, canWork: () => boolean = () => true): void {
    const store = this.news.store,
      config = this.news.config();
    if (!config.enabled || store.settings().paused || this.blockers(now).length || !canWork())
      return;
    // No catch-up burst: first activation starts the current Phoenix day.
    const today = phoenixDay(now),
      cursor = store.get<string | null>('news_digest_day', null);
    if (cursor === null) store.set('news_digest_day', today);
    if (config.digest && cursor !== null && cursor !== today) {
      const end = midnight(today),
        start = end - 86400000;
      const rows = store.db
        .prepare(
          'SELECT id FROM news_events WHERE created_at>=? AND created_at<? AND expires_at>? ORDER BY created_at DESC,id LIMIT 25',
        )
        .all(start, end, now) as { id: string }[];
      const selected: NewsItem[] = [];
      for (const row of rows) {
        if (!canWork()) return;
        const items = this.items(row.id, now);
        if (items.length) selected.push(items[0]!);
        if (selected.length === 5) break;
      }
      store.transaction(() => {
        if (selected.length) this.enqueue(newsId('news-digest', today), 'digest', selected, now);
        store.set('news_digest_day', today);
      });
    } else if (!config.digest && cursor !== today) store.set('news_digest_day', today);
    if (!config.alerts || !canWork()) return;
    const rows = store.db
      .prepare(
        "SELECT id FROM news_events WHERE severity='high' AND expires_at>? AND created_at>=? ORDER BY created_at DESC,id LIMIT 25",
      )
      .all(now, now - 7200000) as { id: string }[];
    for (const row of rows) {
      if (!canWork()) return;
      const id = newsId('news-alert', row.id);
      if (store.db.prepare('SELECT id FROM news_deliveries WHERE id=?').get(id)) continue;
      const caps = store.db
        .prepare(
          "SELECT SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS hour,SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS day FROM news_deliveries WHERE kind='alert' AND created_at>=?",
        )
        .get(now - 3600000, midnight(today), Math.min(now - 3600000, midnight(today))) as {
        hour: number | null;
        day: number;
      };
      if ((caps.hour ?? 0) >= 2 || (caps.day ?? 0) >= 6) break;
      const items = this.alertItems(row.id, now);
      if (items.length) this.enqueue(id, 'alert', items, now);
    }
  }
  suppress(event: SignalEvent): void {
    const id = event.newsReport?.deliveryId;
    if (!id) return;
    this.news.store.transaction(() => {
      const pending = this.news.store.db
        .prepare("SELECT id FROM news_deliveries WHERE id=? AND status='pending'")
        .get(id);
      if (pending) new NewsMonitor(this.news).count(Date.now(), { publicationSuppressed: 1 });
      this.news.store.db
        .prepare("UPDATE news_deliveries SET status='suppressed' WHERE id=? AND status='pending'")
        .run(id);
      this.news.store.db
        .prepare(
          "UPDATE outbox SET status='suppressed' WHERE event_id=? AND status IN ('pending','dead')",
        )
        .run(event.id);
    });
  }
  report(event: SignalEvent, now: number): { title: string; items: NewsItem[] } | null {
    const config = this.news.config(),
      store = this.news.store;
    const row = store.db
      .prepare(
        'SELECT id,kind,created_at,expires_at,status FROM news_deliveries WHERE id=? AND event_id=?',
      )
      .get(event.newsReport?.deliveryId ?? '', event.id) as Delivery | undefined;
    if (
      !row ||
      row.status === 'suppressed' ||
      row.expires_at <= now ||
      !config.enabled ||
      !(row.kind === 'alert' ? config.alerts : config.digest) ||
      store.settings().paused ||
      this.blockers(now).length
    )
      return null;
    const rows = store.db
      .prepare(
        'SELECT article_id,news_event_id,policy_versions,expires_at FROM news_delivery_items WHERE delivery_id=? ORDER BY article_id LIMIT 20',
      )
      .all(row.id) as {
      article_id: string;
      news_event_id: string;
      policy_versions: string;
      expires_at: number;
    }[];
    if (!rows.length) return null;
    const items: NewsItem[] = [];
    for (const ref of rows) {
      const current = (
        row.kind === 'alert'
          ? this.alertItems(ref.news_event_id, now)
          : this.items(ref.news_event_id, now)
      ).find((i) => i.articleId === ref.article_id);
      if (
        !current ||
        ref.expires_at <= now ||
        JSON.stringify(
          current.observations.map((o) => ({ id: o.id, policyVersions: o.policyVersions })),
        ) !== ref.policy_versions
      )
        return null;
      items.push(current);
    }
    return {
      title:
        row.kind === 'alert'
          ? 'News alert · informational'
          : `News digest · ${phoenixDay(row.created_at - 86400000)}`,
      items,
    };
  }
  destination(event: SignalEvent): string | undefined {
    return this.news.store.settings().channels[
      event.newsReport &&
      this.news.store.db
        .prepare("SELECT id FROM news_deliveries WHERE id=? AND kind='alert'")
        .get(event.newsReport.deliveryId)
        ? 'updates'
        : 'summaries'
    ];
  }
  delivered(event: SignalEvent, now: number): void {
    this.news.store.transaction(() => {
      const pending = this.news.store.db
        .prepare("SELECT id FROM news_deliveries WHERE id=? AND status='pending'")
        .get(event.newsReport?.deliveryId ?? '');
      if (!pending) return;
      const report = this.report(event, now);
      this.news.store.db
        .prepare("UPDATE news_deliveries SET status='delivered' WHERE id=? AND status='pending'")
        .run(event.newsReport?.deliveryId ?? '');
      const destination = this.destination(event);
      if (destination && this.news.store.receipt(event.id, destination) && report) {
        const monitor = new NewsMonitor(this.news);
        monitor.count(now, {
          alerts: report.title.startsWith('News alert') ? 1 : 0,
          digests: report.title.startsWith('News digest') ? 1 : 0,
          ...Object.fromEntries(
            ['fresh', 'stale', 'unknown', 'future'].map((key) => [
              key,
              report.items.filter((i) => i.freshness === key).length,
            ]),
          ),
        });
      }
    });
  }
  failed(now = Date.now()): void {
    const monitor = new NewsMonitor(this.news);
    monitor.count(now, { deliveryFailures: 1 });
  }
  sources(now: number) {
    const policies = this.news.policies(),
      config = this.news.config();
    return (['marketaux', 'currents', 'gdelt'] as NewsProvider[]).map((provider) => ({
      provider,
      enabled: config.providers[provider],
      licensedPublishers: [
        ...new Set(
          policies
            .filter(
              (p) =>
                p.scope === 'publisher' &&
                p.publisherDomain &&
                permitted(policies, provider, p.publisherDomain, 'publishMetadata', now),
            )
            .filter((p) => p.provider === provider)
            .map((p) => p.publisherDomain!),
        ),
      ].sort(),
    }));
  }
}
