import { countNewsMetrics } from './metrics.js';
import { financialSentiment } from './sentiment.js';
import { mapInstruments, NEWS_ANALYTICS_VERSION } from './mapping.js';
import {
  classifyEvent,
  titleTokens,
  canCluster,
  clusterSchema,
  clusterSummary,
  type ClusterEvidence,
  type NewsCluster,
} from './clustering.js';
import { newsId, publisherDomain } from './normalize.js';
import { NEWS_LIMITS } from './config.js';
import type { NewsStore } from './store.js';
import { NewsError } from './transport.js';
export interface IntelligenceResult {
  processed: number;
  unchanged: number;
  failed: number;
}
type Inputs = ReturnType<NewsStore['analysisObservations']>;
export class NewsIntelligence {
  constructor(readonly news: NewsStore) {}
  private eventCount(): number {
    const value = this.news.store.get<number | null>('news_event_count', null);
    if (value !== null) return value;
    const count = (
      this.news.store.db.prepare('SELECT COUNT(*) AS n FROM news_events').get() as { n: number }
    ).n;
    this.news.store.set('news_event_count', count);
    return count;
  }
  private removeCluster(id: string): void {
    const store = this.news.store,
      count = this.eventCount();
    store.db
      .prepare(
        "UPDATE outbox SET status='suppressed' WHERE event_id IN (SELECT event_id FROM news_deliveries WHERE id IN (SELECT delivery_id FROM news_delivery_items WHERE news_event_id=?)) AND status IN ('pending','dead')",
      )
      .run(id);
    store.db
      .prepare(
        "UPDATE news_deliveries SET status='suppressed' WHERE id IN (SELECT delivery_id FROM news_delivery_items WHERE news_event_id=?) AND status='pending'",
      )
      .run(id);
    store.db.prepare('DELETE FROM news_delivery_items WHERE news_event_id=?').run(id);
    store.db.prepare('DELETE FROM news_sentiments WHERE event_id=?').run(id);
    store.db.prepare('DELETE FROM news_event_articles WHERE event_id=?').run(id);
    store.db.prepare('DELETE FROM news_events WHERE id=?').run(id);
    store.set('news_event_count', Math.max(0, count - 1));
  }
  private writeCluster(id: string, body: NewsCluster, now: number): number {
    const store = this.news.store,
      summary = clusterSummary(body, now);
    const existing = store.db.prepare('SELECT id FROM news_events WHERE id=?').get(id);
    if (!existing && this.eventCount() >= NEWS_LIMITS.events)
      throw new NewsError('NEWS_STORAGE_LIMIT');
    const published = body.evidence.flatMap((e) => (e.publishedAt === null ? [] : [e.publishedAt]));
    const encoded = JSON.stringify(body);
    store.db
      .prepare(
        `INSERT INTO news_events VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET severity=excluded.severity,event_time=excluded.event_time,expires_at=excluded.expires_at,body=excluded.body`,
      )
      .run(
        id,
        body.topic,
        body.eventClass,
        summary.severity,
        published.length ? Math.min(...published) : null,
        Math.min(...body.evidence.map((e) => e.ingestedAt)),
        summary.expiresAt,
        NEWS_ANALYTICS_VERSION,
        encoded,
      );
    if (!existing) store.set('news_event_count', this.eventCount() + 1);
    store.db.prepare('DELETE FROM news_event_articles WHERE event_id=?').run(id);
    for (const evidence of body.evidence)
      store.db.prepare('INSERT INTO news_event_articles VALUES(?,?)').run(id, evidence.articleId);
    return Buffer.byteLength(encoded) * 4 + 2048;
  }
  private seed(now: number): void {
    const store = this.news.store;
    let sweep = store.get('news_analysis_sweep', { version: '', cursor: '', done: false, at: 0 });
    if (
      sweep.version !== NEWS_ANALYTICS_VERSION ||
      store.get('news_analysis_refresh_requested', false) ||
      (sweep.done && now - sweep.at >= 3600000)
    ) {
      sweep = { version: NEWS_ANALYTICS_VERSION, cursor: '', done: false, at: now };
      store.set('news_analysis_refresh_requested', false);
    }
    if (sweep.done) return;
    store.transaction(() => {
      const rows = store.db
        .prepare('SELECT id FROM news_articles WHERE id>? ORDER BY id LIMIT 20')
        .all(sweep.cursor) as { id: string }[];
      for (const row of rows)
        store.db
          .prepare(
            'INSERT INTO news_analysis_queue(article_id,requested_at) VALUES(?,?) ON CONFLICT(article_id) DO NOTHING',
          )
          .run(row.id, now);
      sweep.cursor = rows.at(-1)?.id ?? sweep.cursor;
      sweep.done = rows.length < 20;
      store.set('news_analysis_sweep', sweep);
    });
  }
  process(now: number, canWork: () => boolean = () => true): IntelligenceResult {
    const result = { processed: 0, unchanged: 0, failed: 0 },
      store = this.news.store;
    if (!this.news.config().enabled || store.settings().paused || !canWork()) return result;
    this.seed(now);
    const rows = store.db
      .prepare(
        'SELECT article_id,attempts FROM news_analysis_queue WHERE next_at<=? AND requested_at<=? ORDER BY requested_at,article_id LIMIT 20',
      )
      .all(now, now) as { article_id: string; attempts: number }[];
    for (const row of rows) {
      if (!canWork()) break;
      try {
        const changed = this.analyzeArticle(row.article_id, now, canWork);
        changed ? result.processed++ : result.unchanged++;
      } catch (error) {
        if (
          error instanceof NewsError &&
          (error.code === 'NEWS_RESOURCE_PAUSED' || error.code === 'NEWS_STORAGE_LIMIT')
        )
          break;
        store.db
          .prepare(
            'UPDATE news_analysis_queue SET attempts=attempts+1,next_at=?,last_error=? WHERE article_id=?',
          )
          .run(
            now + Math.min(3600000, 60000 * 2 ** Math.min(row.attempts, 6)),
            'NEWS_ANALYSIS_FAILED',
            row.article_id,
          );
        countNewsMetrics(this.news, now, { analysisFailures: 1 });
        result.failed++;
      }
    }
    return result;
  }
  private analyzeArticle(articleId: string, now: number, canWork: () => boolean): boolean {
    const store = this.news.store,
      inputs = this.news.analysisObservations(articleId, now),
      aliases = this.news.aliases(now),
      groups = this.news.publisherGroups(now),
      instruments = store.monitored();
    const fingerprint = newsId(NEWS_ANALYTICS_VERSION, inputs, aliases, groups, instruments);
    const previous = store.db
      .prepare('SELECT fingerprint FROM news_analysis_state WHERE article_id=?')
      .get(articleId) as { fingerprint: string } | undefined;
    if (previous?.fingerprint === fingerprint) {
      store.db.prepare('DELETE FROM news_analysis_queue WHERE article_id=?').run(articleId);
      return false;
    }
    const mappings = mapInstruments(inputs, instruments, aliases, now);
    const primary =
      inputs.find((i) => i.observation.headline || i.observation.description) ?? inputs[0];
    const text = primary
      ? [primary.observation.headline, primary.observation.description].filter(Boolean).join(' ')
      : '';
    const classification = classifyEvent(text),
      local = financialSentiment(text);
    const publications = inputs.flatMap((i) =>
      i.observation.publishedAt === null ? [] : [i.observation.publishedAt],
    );
    const firstSeen = inputs.flatMap((i) =>
      i.observation.firstSeenAt === null ? [] : [i.observation.firstSeenAt],
    );
    const publishedAt = publications.length ? Math.min(...publications) : null;
    const refs = inputs.map((i) => ({
      id: i.id,
      provider: i.observation.provider,
      providerArticleId: i.observation.providerArticleId,
      policyVersions: i.policyVersions,
      expiresAt: i.expiresAt,
    }));
    const expiresAt = inputs.length ? Math.min(...inputs.map((i) => i.expiresAt)) : now;
    return store.transaction(() => {
      if (!canWork()) throw new NewsError('NEWS_RESOURCE_PAUSED');
      const old = store.db
        .prepare('SELECT event_id FROM news_event_articles WHERE article_id=?')
        .all(articleId) as { event_id: string }[];
      const target = new Set<string>();
      let bytes = 0;
      store.db.prepare('DELETE FROM news_instrument_links WHERE article_id=?').run(articleId);
      store.db.prepare('DELETE FROM news_sentiments WHERE article_id=?').run(articleId);
      if (primary) {
        for (const mapping of mappings) {
          const encoded = JSON.stringify({ mapping, observations: refs });
          store.db
            .prepare('INSERT INTO news_instrument_links VALUES(?,?,?,?,?,?,?)')
            .run(
              articleId,
              mapping.instrumentId,
              mapping.method,
              mapping.confidence,
              encoded,
              NEWS_ANALYTICS_VERSION,
              expiresAt,
            );
          bytes += Buffer.byteLength(encoded) * 4 + 1024;
        }
        const sentiment = (
          id: string,
          instrumentId: string | null,
          origin: string,
          score: number | null,
          confidence: number,
          body: unknown,
        ) => {
          const encoded = JSON.stringify(body);
          store.db
            .prepare('INSERT INTO news_sentiments VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(
              id,
              articleId,
              null,
              instrumentId,
              origin,
              score,
              confidence,
              NEWS_ANALYTICS_VERSION,
              expiresAt,
              encoded,
            );
          bytes += Buffer.byteLength(encoded) * 4 + 1024;
        };
        sentiment(
          newsId(NEWS_ANALYTICS_VERSION, articleId, 'local'),
          mappings.length === 1 ? mappings[0]!.instrumentId : null,
          'local',
          local.score,
          local.confidence,
          {
            scope: mappings.length === 1 ? 'instrument' : 'article',
            local,
            mappings,
            observations: refs,
          },
        );
        // Keep every provider entity score separate; do not blend with local sentiment.
        for (const input of inputs) {
          const ownMappings = mapInstruments([input], instruments, aliases, now);
          input.observation.entities.forEach((entity, index) => {
            const mapping = mappings.find(
              (m) =>
                m.method === 'provider_entity' &&
                m.instrumentId &&
                m.observationId === input.id &&
                m.entityIndex === index,
            );
            // Other observations can corroborate the same verified entity identity.
            const own = ownMappings.find(
              (m) => m.method === 'provider_entity' && m.entityIndex === index,
            );
            const matched = mapping ?? own;
            if (entity.sentimentScore === null || !matched) return;
            sentiment(
              newsId(NEWS_ANALYTICS_VERSION, articleId, input.id, index),
              matched.instrumentId,
              input.observation.provider,
              entity.sentimentScore,
              matched.confidence,
              {
                scope: 'provider_entity',
                mapping: matched,
                provider: input.observation.provider,
                entityIndex: index,
                symbol: entity.symbol,
                venue: entity.venue,
                matchScore: entity.matchScore,
                observations: [refs.find((r) => r.id === input.id)!],
              },
            );
          });
        }
        const topics =
          classification.eventClass === 'macro_policy'
            ? [{ topic: 'macro:monetary_policy', mapping: null }]
            : mappings.length
              ? mappings.map((mapping) => ({
                  topic: `instrument:${mapping.instrumentId}`,
                  mapping,
                }))
              : [
                  {
                    topic: /\b(bitcoin|ethereum|crypto)\b/i.test(text)
                      ? 'macro:crypto'
                      : `unmapped:${articleId}`,
                    mapping: null,
                  },
                ];
        let examined = 0;
        for (const item of topics) {
          if (!canWork()) throw new NewsError('NEWS_RESOURCE_PAUSED');
          const evidence: ClusterEvidence = {
            articleId,
            observations: refs,
            titleTokens: titleTokens(primary.observation.headline),
            anchorTime:
              publishedAt ??
              (firstSeen.length ? Math.min(...firstSeen) : primary.observation.ingestedAt),
            publishedAt,
            firstSeenAt: firstSeen.length ? Math.min(...firstSeen) : null,
            publicationConflict:
              publications.length > 1 &&
              Math.max(...publications) - Math.min(...publications) > 900000,
            ingestedAt: Math.min(...inputs.map((i) => i.observation.ingestedAt)),
            expiresAt,
            classification,
            mapping: item.mapping,
            mappingConfidence: item.mapping?.confidence ?? 0,
            publisherDomain: publisherDomain(primary.observation.url),
            publisherGroup:
              groups.find((g) => g.domain === publisherDomain(primary.observation.url)) ?? null,
          };
          const own = store.db
            .prepare(
              'SELECT e.id,e.body FROM news_events e JOIN news_event_articles m ON m.event_id=e.id WHERE m.article_id=? AND e.topic=? AND e.event_class=? AND e.analytics_version=? LIMIT ?',
            )
            .all(
              articleId,
              item.topic,
              classification.eventClass,
              NEWS_ANALYTICS_VERSION,
              50 - examined,
            ) as { id: string; body: string }[];
          examined += own.length;
          const candidates = store.db
            .prepare(
              'SELECT id,body FROM news_events WHERE topic=? AND event_class=? AND analytics_version=? AND created_at BETWEEN ? AND ? AND expires_at>? ORDER BY created_at,id LIMIT ?',
            )
            .all(
              item.topic,
              classification.eventClass,
              NEWS_ANALYTICS_VERSION,
              Math.max(0, evidence.ingestedAt - 86400000),
              Math.min(now, evidence.ingestedAt + 86400000),
              now,
              50 - examined,
            ) as { id: string; body: string }[];
          examined += candidates.length;
          let selected: { id: string; body: NewsCluster } | undefined;
          for (const candidate of [...own, ...candidates]) {
            if (!canWork()) throw new NewsError('NEWS_RESOURCE_PAUSED');
            const parsed = clusterSchema.safeParse(JSON.parse(candidate.body));
            if (!parsed.success) continue;
            const live: ClusterEvidence[] = [];
            for (const member of parsed.data.evidence) {
              if (!canWork()) throw new NewsError('NEWS_RESOURCE_PAUSED');
              if (
                member.articleId === articleId ||
                this.currentEvidence(member, parsed.data.topic, now)
              )
                live.push(member);
            }
            parsed.data.evidence = live;
            if (canCluster(parsed.data, evidence)) {
              selected = { id: candidate.id, body: parsed.data };
              break;
            }
          }
          const id =
            selected?.id ??
            newsId(
              NEWS_ANALYTICS_VERSION,
              item.topic,
              classification.eventClass,
              classification.contextKey,
              articleId,
            );
          const body: NewsCluster = selected?.body ?? {
            version: NEWS_ANALYTICS_VERSION,
            topic: item.topic,
            eventClass: classification.eventClass,
            contextKey: classification.contextKey,
            evidence: [],
          };
          body.evidence = [
            ...body.evidence.filter((e) => e.articleId !== articleId),
            evidence,
          ].sort((a, b) => a.articleId.localeCompare(b.articleId));
          bytes += this.writeCluster(id, clusterSchema.parse(body), now);
          store.db
            .prepare('INSERT INTO news_event_articles VALUES(?,?) ON CONFLICT DO NOTHING')
            .run(id, articleId);
          target.add(id);
        }
      }
      for (const member of old)
        if (!target.has(member.event_id)) {
          const row = store.db
            .prepare('SELECT body FROM news_events WHERE id=?')
            .get(member.event_id) as { body: string } | undefined;
          if (!row) continue;
          const body = clusterSchema.parse(JSON.parse(row.body));
          body.evidence = body.evidence.filter((e) => e.articleId !== articleId);
          store.db
            .prepare('DELETE FROM news_event_articles WHERE event_id=? AND article_id=?')
            .run(member.event_id, articleId);
          if (!body.evidence.length) this.removeCluster(member.event_id);
          else bytes += this.writeCluster(member.event_id, body, now);
        }
      const estimate = store.get('news_storage_estimate', { day: '', bytes: 0 });
      if (estimate.day && estimate.bytes + bytes >= NEWS_LIMITS.storageBytes)
        throw new NewsError('NEWS_STORAGE_LIMIT');
      if (estimate.day)
        store.set('news_storage_estimate', { ...estimate, bytes: estimate.bytes + bytes });
      if (primary)
        countNewsMetrics(this.news, now, {
          analyzed: 1,
          mapped: mappings.length ? 1 : 0,
          unmapped: mappings.length ? 0 : 1,
        });
      store.db
        .prepare(
          'INSERT INTO news_analysis_state VALUES(?,?,?) ON CONFLICT(article_id) DO UPDATE SET fingerprint=excluded.fingerprint,processed_at=excluded.processed_at',
        )
        .run(articleId, fingerprint, now);
      store.db.prepare('DELETE FROM news_analysis_queue WHERE article_id=?').run(articleId);
      return true;
    });
  }
  private currentEvidence(evidence: ClusterEvidence, topic: string, now: number): boolean {
    if (evidence.expiresAt <= now || evidence.ingestedAt > now) return false;
    const inputs = this.news.analysisObservations(evidence.articleId, now);
    if (
      !evidence.observations.every((ref) =>
        inputs.some(
          (i) =>
            i.id === ref.id &&
            i.expiresAt >= evidence.expiresAt &&
            JSON.stringify(i.policyVersions) === JSON.stringify(ref.policyVersions),
        ),
      )
    )
      return false;
    const review =
      this.news.publisherGroups(now).find((g) => g.domain === evidence.publisherDomain) ?? null;
    if (JSON.stringify(review) !== JSON.stringify(evidence.publisherGroup)) return false;
    if (topic.startsWith('instrument:')) {
      const mapping = mapInstruments(
        inputs,
        this.news.store.monitored(),
        this.news.aliases(now),
        now,
      ).find((m) => `instrument:${m.instrumentId}` === topic);
      if (!mapping || JSON.stringify(mapping) !== JSON.stringify(evidence.mapping)) return false;
    }
    return true;
  }
  event(
    id: string,
    now: number,
  ): { id: string; cluster: NewsCluster; summary: ReturnType<typeof clusterSummary> } | null {
    const row = this.news.store.db
      .prepare('SELECT body FROM news_events WHERE id=? AND expires_at>? AND analytics_version=?')
      .get(id, now, NEWS_ANALYTICS_VERSION) as { body: string } | undefined;
    if (!row) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.body);
    } catch {
      return null;
    }
    const parsed = clusterSchema.safeParse(decoded);
    if (
      !parsed.success ||
      !parsed.data.evidence.every((e) => this.currentEvidence(e, parsed.data.topic, now))
    )
      return null;
    return { id, cluster: parsed.data, summary: clusterSummary(parsed.data, now) };
  }
  sentiments(instrumentId: string | null, now: number) {
    const rows = this.news.store.db
      .prepare(
        'SELECT id,article_id,origin,score,confidence,body FROM news_sentiments WHERE instrument_id IS ? AND expires_at>? AND rules_version=? ORDER BY id LIMIT 50',
      )
      .all(instrumentId, now, NEWS_ANALYTICS_VERSION) as {
      id: string;
      article_id: string;
      origin: string;
      score: number | null;
      confidence: number;
      body: string;
    }[];
    return rows.flatMap((row) => {
      let body: {
        observations: ClusterEvidence['observations'];
        scope: string;
        mappings?: ReturnType<typeof mapInstruments>;
        mapping?: ReturnType<typeof mapInstruments>[number];
      };
      try {
        body = JSON.parse(row.body);
      } catch {
        return [];
      }
      if (!body || !Array.isArray(body.observations) || !body.observations.length) return [];
      const inputs = this.news.analysisObservations(row.article_id, now);
      const current = mapInstruments(
        inputs,
        this.news.store.monitored(),
        this.news.aliases(now),
        now,
      );
      if (row.origin === 'local' && JSON.stringify(current) !== JSON.stringify(body.mappings))
        return [];
      if (row.origin !== 'local') {
        const own = inputs.find((i) => i.id === body.mapping?.observationId);
        const matches = own
          ? mapInstruments([own], this.news.store.monitored(), this.news.aliases(now), now)
          : [];
        if (!matches.some((m) => JSON.stringify(m) === JSON.stringify(body.mapping))) return [];
      }
      if (
        !body.observations?.every((ref) =>
          inputs.some(
            (i) =>
              i.id === ref.id &&
              JSON.stringify(i.policyVersions) === JSON.stringify(ref.policyVersions),
          ),
        )
      )
        return [];
      return [
        {
          id: row.id,
          articleId: row.article_id,
          origin: row.origin,
          score: row.score,
          confidence: row.confidence,
          explanation: body,
        },
      ];
    });
  }
}
