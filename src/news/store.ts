import { countNewsMetrics } from './metrics.js';
import type { Store } from '../sql-store.js';
import { initialNewsConfig, NEWS_LIMITS, newsConfigSchema } from './config.js';
import { newsId } from './normalize.js';
import { applicablePolicies, permitted, policySchema, type NewsPolicy } from './policies.js';
import { initializeNewsSchema } from './schema.js';
import { timestampSchema, validateObservation } from './validation.js';
import { aliasSchema, type NewsAlias } from './mapping.js';
import { publisherGroupSchema, type PublisherGroup } from './clustering.js';
import type { NewsObservation, NewsProvider } from './types.js';
type ObservationRow = { id: string; article_id: string; expires_at: number; body: string };
export class NewsStore {
  constructor(
    readonly store: Store,
    now = Date.now(),
  ) {
    initializeNewsSchema(store, timestampSchema.parse(now));
  }
  config() {
    return newsConfigSchema.parse(this.store.get('news_config', initialNewsConfig()));
  }
  saveConfig(value: unknown) {
    const next = newsConfigSchema.parse(value);
    this.store.transaction(() => {
      const previous = this.config();
      this.store.set('news_config', next);
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        this.store.db
          .prepare(
            "UPDATE outbox SET status='suppressed' WHERE status IN ('pending','dead') AND event_id IN (SELECT event_id FROM news_deliveries WHERE status='pending')",
          )
          .run();
        this.store.db
          .prepare("UPDATE news_deliveries SET status='suppressed' WHERE status='pending'")
          .run();
        this.store.set('news_soak_state', {
          signature: '',
          start: 0,
          lastHealthy: 0,
          privateAt: 0,
        });
        this.store.set('news_rollout_snapshot', null);
        this.store.set('news_soak_start', 0);
        this.store.set('news_healthy_at', 0);
        this.store.set('news_production_approved', false);
        this.store.set('news_digest_day', null);
      }
    });
  }
  policies(): NewsPolicy[] {
    return (
      this.store.db.prepare('SELECT body FROM news_source_policies').all() as { body: string }[]
    ).map((r) => policySchema.parse(JSON.parse(r.body)));
  }
  savePolicy(value: unknown): void {
    const p = policySchema.parse(value),
      body = JSON.stringify(p);
    this.store.transaction(() => {
      const existing = this.store.db
        .prepare('SELECT body FROM news_source_policies WHERE id=? AND version=?')
        .get(p.id, p.version) as { body: string } | undefined;
      if (existing) {
        if (existing.body !== body) throw new Error('NEWS_POLICY_IMMUTABLE');
        return;
      }
      this.store.db
        .prepare('INSERT INTO news_source_policies VALUES(?,?,?,?,?,?)')
        .run(p.id, p.version, p.provider, p.scope, p.publisherDomain ?? '', body);
      this.store.set('news_analysis_refresh_requested', true);
      this.store.set('news_production_approved', false);
      // A new review can tighten rights. Suppress queued output immediately; do not
      // mutate journal or receipt history. Later publication must recheck policies.
      const domain = p.publisherDomain;
      const deliveries = this.store.db
        .prepare(
          `SELECT DISTINCT d.id,d.event_id FROM news_deliveries d
        JOIN news_delivery_items i ON i.delivery_id=d.id JOIN news_articles a ON a.id=i.article_id
        JOIN news_observations o ON o.article_id=a.id WHERE o.provider=? AND (? IS NULL OR a.domain=?) AND d.status='pending'`,
        )
        .all(p.provider, domain, domain) as { id: string; event_id: string | null }[];
      if (deliveries.length)
        countNewsMetrics(this, Date.now(), { publicationSuppressed: deliveries.length });
      for (const d of deliveries) {
        this.store.db
          .prepare("UPDATE news_deliveries SET status='suppressed' WHERE id=?")
          .run(d.id);
        if (d.event_id)
          this.store.db
            .prepare(
              "UPDATE outbox SET status='suppressed' WHERE event_id=? AND status IN ('pending','dead')",
            )
            .run(d.event_id);
      }
    });
  }
  saveObservation(
    value: unknown,
    now = Date.now(),
  ): {
    articleId: string;
    observationId: string;
    duplicate?: boolean;
    canonicalDuplicate?: boolean;
  } {
    timestampSchema.parse(now);
    const o = validateObservation(value);
    if (o.ingestedAt > now) throw new Error('NEWS_FUTURE_INGESTION');
    return this.store.transaction(() => {
      const policies = this.policies(),
        allowed = (cap: Parameters<typeof permitted>[3]) =>
          permitted(policies, o.provider, o.publisherDomain, cap, now);
      if (!allowed('ingest') || !allowed('retainMetadata')) throw new Error('NEWS_STORAGE_DENIED');
      const applicable = applicablePolicies(policies, o.provider, o.publisherDomain);
      const expiresAt = Math.min(
        o.ingestedAt + NEWS_LIMITS.articleRetentionMs,
        ...applicable.map((p) => Math.min(p.expiresAt, o.ingestedAt + (p.retentionMs ?? 0))),
      );
      if (expiresAt <= now) throw new Error('NEWS_RETENTION_EXPIRED');
      const { publisherDomain: _domain, ...base } = o;
      const sanitized: NewsObservation = {
        ...base,
        headline: allowed('retainHeadline') ? o.headline : null,
        description: allowed('retainDescription') ? o.description : null,
        entities: allowed('analyze') && allowed('retainDerived') ? o.entities : [],
        policyVersions: applicable.map((p) => `${p.id}@${p.version}`),
      };
      const urlHash = newsId(o.url),
        articleId = newsId('article', o.url),
        observationId = newsId(o.provider, o.providerArticleId);
      const existing = this.store.db
        .prepare('SELECT article_id FROM news_observations WHERE id=?')
        .get(observationId) as { article_id: string } | undefined;
      if (existing && existing.article_id !== articleId) throw new Error('NEWS_IDENTITY_CONFLICT');
      if (existing) return { articleId, observationId, duplicate: true };
      const counts = this.counts();
      const article = this.store.db
        .prepare('SELECT id FROM news_articles WHERE id=?')
        .get(articleId);
      if (
        counts.observations >= NEWS_LIMITS.observations ||
        (!article && counts.articles >= NEWS_LIMITS.articles)
      )
        throw new Error('NEWS_STORAGE_LIMIT');
      this.store.db
        .prepare(
          `INSERT INTO news_articles VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_ingested_at=MAX(last_ingested_at,excluded.last_ingested_at),expires_at=MAX(expires_at,excluded.expires_at)`,
        )
        .run(articleId, urlHash, o.url, o.publisherDomain, o.ingestedAt, o.ingestedAt, expiresAt);
      const storage = this.store.get('news_storage_estimate', { day: '', bytes: 0 });
      const delta =
        4 * Buffer.byteLength(JSON.stringify(sanitized) + (article ? '' : o.url), 'utf8') +
        (article ? 2048 : 4096);
      if (storage.day && storage.bytes + delta >= NEWS_LIMITS.storageBytes)
        throw new Error('NEWS_STORAGE_LIMIT');
      this.store.db
        .prepare('INSERT INTO news_observations VALUES(?,?,?,?,?,?,?,?,?)')
        .run(
          observationId,
          o.provider,
          o.providerArticleId,
          articleId,
          o.ingestedAt,
          o.publishedAt,
          o.firstSeenAt,
          expiresAt,
          JSON.stringify(sanitized),
        );
      this.store.set('news_record_counts', {
        articles: counts.articles + (article ? 0 : 1),
        observations: counts.observations + 1,
      });
      if (storage.day)
        this.store.set('news_storage_estimate', { ...storage, bytes: storage.bytes + delta });
      this.enqueueAnalysis(articleId, now);
      return { articleId, observationId, ...(article ? { canonicalDuplicate: true } : {}) };
    });
  }
  enqueueAnalysis(articleId: string, now: number): void {
    this.store.db
      .prepare(
        'INSERT INTO news_analysis_queue(article_id,requested_at) VALUES(?,?) ON CONFLICT(article_id) DO UPDATE SET requested_at=excluded.requested_at,next_at=0,last_error=NULL',
      )
      .run(articleId, now);
  }
  saveAlias(value: unknown): void {
    const a = aliasSchema.parse(value);
    this.store.transaction(() => {
      this.store.db
        .prepare(
          'INSERT INTO news_aliases VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET instrument_id=excluded.instrument_id,alias=excluded.alias,venue=excluded.venue,reviewed_at=excluded.reviewed_at,body=excluded.body',
        )
        .run(a.id, a.instrumentId, a.alias, a.venue, a.reviewedAt, JSON.stringify(a));
      this.store.set('news_analysis_refresh_requested', true);
      this.store.set('news_reconciled', { at: 0, config: '' });
    });
  }
  aliases(now: number): NewsAlias[] {
    const rows = this.store.db
      .prepare('SELECT body FROM news_aliases WHERE reviewed_at<=? ORDER BY id LIMIT 1000')
      .all(now) as { body: string }[];
    return rows.flatMap((row) => {
      try {
        const a = aliasSchema.parse(JSON.parse(row.body));
        return a.expiresAt > now ? [a] : [];
      } catch {
        return [];
      }
    });
  }
  savePublisherGroup(value: unknown): void {
    const p = publisherGroupSchema.parse(value);
    this.store.transaction(() => {
      this.store.db
        .prepare(
          'INSERT INTO news_publisher_groups VALUES(?,?) ON CONFLICT(domain) DO UPDATE SET body=excluded.body',
        )
        .run(p.domain, JSON.stringify(p));
      this.store.set('news_analysis_refresh_requested', true);
    });
  }
  publisherGroups(now: number): PublisherGroup[] {
    return (
      this.store.db
        .prepare('SELECT body FROM news_publisher_groups ORDER BY domain LIMIT 200')
        .all() as { body: string }[]
    ).flatMap((row) => {
      try {
        const p = publisherGroupSchema.parse(JSON.parse(row.body));
        return p.reviewedAt <= now && p.expiresAt > now ? [p] : [];
      } catch {
        return [];
      }
    });
  }
  analysisObservations(articleId: string, now: number) {
    const policies = this.policies();
    const rows = this.store.db
      .prepare(
        'SELECT * FROM news_observations WHERE article_id=? AND ingested_at<=? AND expires_at>? ORDER BY provider,provider_article_id LIMIT 10',
      )
      .all(articleId, now, now) as ObservationRow[];
    return rows.flatMap((row) => {
      const raw = validateObservation(JSON.parse(row.body));
      const allowed = (cap: Parameters<typeof permitted>[3]) =>
        permitted(policies, raw.provider, raw.publisherDomain, cap, now);
      if (!allowed('analyze') || !allowed('retainDerived')) return [];
      const observation = this.observation(raw.provider, raw.providerArticleId, now);
      if (!observation || observation.language !== 'en') return [];
      const applicable = applicablePolicies(policies, raw.provider, raw.publisherDomain);
      const expiresAt = Math.min(
        row.expires_at,
        observation.ingestedAt + NEWS_LIMITS.derivedRetentionMs,
        ...applicable.map((p) =>
          Math.min(p.expiresAt, observation.ingestedAt + (p.retentionMs ?? 0)),
        ),
      );
      return expiresAt > now
        ? [
            {
              id: row.id,
              observation,
              expiresAt,
              policyVersions: applicable.map((p) => `${p.id}@${p.version}`),
            },
          ]
        : [];
    });
  }
  counts(): { articles: number; observations: number } {
    const cached = this.store.get<{ articles: number; observations: number } | null>(
      'news_record_counts',
      null,
    );
    if (cached) return cached;
    const counts = this.store.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM news_articles) AS articles,(SELECT COUNT(*) FROM news_observations) AS observations',
      )
      .get() as { articles: number; observations: number };
    this.store.set('news_record_counts', counts);
    return counts;
  }
  observation(
    provider: NewsProvider,
    providerArticleId: string,
    now = Date.now(),
  ): NewsObservation | null {
    timestampSchema.parse(now);
    const row = this.store.db
      .prepare('SELECT * FROM news_observations WHERE provider=? AND provider_article_id=?')
      .get(provider, providerArticleId) as ObservationRow | undefined;
    if (!row || row.expires_at <= now) return null;
    const o = validateObservation(JSON.parse(row.body)),
      policies = this.policies();
    const allowed = (cap: Parameters<typeof permitted>[3]) =>
      permitted(policies, o.provider, o.publisherDomain, cap, now);
    if (!allowed('ingest') || !allowed('retainMetadata')) return null;
    const effectiveExpiry = Math.min(
      row.expires_at,
      ...applicablePolicies(policies, o.provider, o.publisherDomain).map((p) =>
        Math.min(p.expiresAt, o.ingestedAt + (p.retentionMs ?? 0)),
      ),
    );
    if (effectiveExpiry <= now) return null;
    const { publisherDomain: _domain, ...base } = o;
    return {
      ...base,
      headline: allowed('retainHeadline') ? o.headline : null,
      description: allowed('retainDescription') ? o.description : null,
      entities: allowed('analyze') && allowed('retainDerived') ? o.entities : [],
    };
  }
  /** Bounded sweep, including revoked rights. No dependence on foreign-key mode. */
  cleanup(now = Date.now(), limit: number = NEWS_LIMITS.cleanupBatch): number {
    timestampSchema.parse(now);
    if (!Number.isInteger(limit) || limit < 1 || limit > NEWS_LIMITS.cleanupBatch)
      throw new Error('NEWS_INVALID_CLEANUP_LIMIT');
    return this.store.transaction(() => {
      this.counts();
      const cursor = this.store.get('news_cleanup_cursor', '');
      const rows = this.store.db
        .prepare('SELECT * FROM news_observations WHERE id>? ORDER BY id LIMIT ?')
        .all(cursor, limit) as ObservationRow[];
      let deleted = 0;
      for (const row of rows) {
        const o = validateObservation(JSON.parse(row.body));
        const safe = this.observation(o.provider, o.providerArticleId, now);
        if (safe) {
          const policies = this.policies();
          if (
            !permitted(policies, o.provider, o.publisherDomain, 'analyze', now) ||
            !permitted(policies, o.provider, o.publisherDomain, 'retainDerived', now)
          )
            this.removeEvidence(row.article_id, now);
          // Physically remove content whose individual field rights were revoked.
          if (
            safe.headline !== o.headline ||
            safe.description !== o.description ||
            safe.entities.length !== o.entities.length
          )
            this.store.db
              .prepare('UPDATE news_observations SET body=? WHERE id=?')
              .run(JSON.stringify(safe), row.id);
          continue;
        }
        this.removeEvidence(row.article_id, now);
        this.store.db.prepare('DELETE FROM news_observations WHERE id=?').run(row.id);
        const removedArticle = !this.store.db
          .prepare('SELECT id FROM news_observations WHERE article_id=? LIMIT 1')
          .get(row.article_id);
        if (removedArticle) {
          this.store.db
            .prepare('DELETE FROM news_analysis_queue WHERE article_id=?')
            .run(row.article_id);
          this.store.db
            .prepare('DELETE FROM news_analysis_state WHERE article_id=?')
            .run(row.article_id);
        } else this.enqueueAnalysis(row.article_id, now);
        this.store.db
          .prepare(
            'DELETE FROM news_articles WHERE id=? AND NOT EXISTS(SELECT 1 FROM news_observations WHERE article_id=?)',
          )
          .run(row.article_id, row.article_id);
        const counts = this.counts();
        this.store.set('news_record_counts', {
          articles: Math.max(0, counts.articles - (removedArticle ? 1 : 0)),
          observations: Math.max(0, counts.observations - 1),
        });
        deleted++;
      }
      this.store.set('news_cleanup_cursor', rows.length === limit ? rows[rows.length - 1]!.id : '');
      return deleted;
    });
  }
  private removeEvidence(articleId: string, now: number): void {
    const db = this.store.db;
    const deliveries = db
      .prepare('SELECT delivery_id FROM news_delivery_items WHERE article_id=?')
      .all(articleId) as { delivery_id: string }[];
    for (const d of deliveries) {
      db.prepare(
        "UPDATE outbox SET status='suppressed' WHERE event_id=(SELECT event_id FROM news_deliveries WHERE id=?) AND status IN ('pending','dead')",
      ).run(d.delivery_id);
      db.prepare(
        "UPDATE news_deliveries SET status='suppressed' WHERE id=? AND status='pending'",
      ).run(d.delivery_id);
    }
    const events = db
      .prepare('SELECT event_id FROM news_event_articles WHERE article_id=?')
      .all(articleId) as { event_id: string }[];
    for (const e of events) {
      const members = db
        .prepare('SELECT article_id FROM news_event_articles WHERE event_id=?')
        .all(e.event_id) as { article_id: string }[];
      for (const member of members) {
        db.prepare('DELETE FROM news_analysis_state WHERE article_id=?').run(member.article_id);
        this.enqueueAnalysis(member.article_id, now);
      }
      // Other deliveries can reference this cluster through different articles.
      // Suppress those too before removing the shared evidence.
      db.prepare(
        "UPDATE outbox SET status='suppressed' WHERE event_id IN (SELECT d.event_id FROM news_deliveries d JOIN news_delivery_items i ON i.delivery_id=d.id WHERE i.news_event_id=?) AND status IN ('pending','dead')",
      ).run(e.event_id);
      db.prepare(
        "UPDATE news_deliveries SET status='suppressed' WHERE id IN (SELECT delivery_id FROM news_delivery_items WHERE news_event_id=?) AND status='pending'",
      ).run(e.event_id);
      db.prepare('DELETE FROM news_delivery_items WHERE news_event_id=?').run(e.event_id);
      db.prepare('DELETE FROM news_sentiments WHERE event_id=?').run(e.event_id);
      db.prepare('DELETE FROM news_event_articles WHERE event_id=?').run(e.event_id);
      db.prepare('DELETE FROM news_events WHERE id=?').run(e.event_id);
      this.store.set('news_event_count', null);
    }
    db.prepare('DELETE FROM news_delivery_items WHERE article_id=?').run(articleId);
    db.prepare('DELETE FROM news_sentiments WHERE article_id=?').run(articleId);
    db.prepare('DELETE FROM news_instrument_links WHERE article_id=?').run(articleId);
    db.prepare('DELETE FROM news_analysis_state WHERE article_id=?').run(articleId);
  }
}
/** Migration errors must never escape into market initialization or expose SQL/content. */
export function initializeNews(
  store: Store,
  now = Date.now(),
): { news: NewsStore | null; error: 'NEWS_INITIALIZATION_FAILED' | null } {
  try {
    return { news: new NewsStore(store, now), error: null };
  } catch {
    return { news: null, error: 'NEWS_INITIALIZATION_FAILED' };
  }
}
