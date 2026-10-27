import { randomUUID } from 'node:crypto';
import { NEWS_LIMITS, type NewsConfig } from './config.js';
import { newsId } from './normalize.js';
import { permitted } from './policies.js';
import { NewsQuota } from './quota.js';
import type { NewsStore } from './store.js';
import type { NewsProvider, NewsQuery } from './types.js';
import { querySchema } from './validation.js';
import { NewsError } from './transport.js';
export interface ScheduledQuery {
  id: string;
  provider: NewsProvider;
  specification: string;
  priority: number;
  due_at: number;
  checkpoint: string | null;
  failures: number;
}
export function approvedDomains(news: NewsStore, provider: NewsProvider, now: number): string[] {
  const policies = news.policies();
  return [
    ...new Set(
      policies
        .filter((p) => p.scope === 'publisher' && p.provider === provider)
        .map((p) => p.publisherDomain!),
    ),
  ]
    .filter(
      (domain) =>
        permitted(policies, provider, domain, 'ingest', now) &&
        permitted(policies, provider, domain, 'retainMetadata', now),
    )
    .sort();
}
const macro = [
  ['Federal Reserve', 'interest rates'],
  ['Bitcoin', 'Ethereum'],
];
export class NewsScheduler {
  readonly quota: NewsQuota;
  constructor(readonly news: NewsStore) {
    this.quota = new NewsQuota(news);
  }
  reconcile(now: number, config: NewsConfig): void {
    const store = this.news.store,
      active = new Set(store.activeIdeas().map((i) => i.candidate.instrument.id));
    const pins = new Set(
      (
        store.db.prepare('SELECT id FROM watch WHERE pinned=1 AND excluded=0').all() as {
          id: string;
        }[]
      ).map((r) => r.id),
    );
    const aliases = this.news.aliases(now);
    const recipes: { query: NewsQuery; priority: number }[] = [];
    const add = (provider: NewsProvider, symbols: string[], terms: string[], priority: number) => {
      const id = newsId(provider, symbols, terms);
      recipes.push({
        query: querySchema.parse({
          id,
          provider,
          symbols,
          terms,
          domains: [],
          startAt: Math.max(0, now - 86400000),
          endAt: now,
          page: 1,
        }),
        priority,
      });
    };
    for (const provider of ['marketaux', 'currents', 'gdelt'] as const) {
      if (!config.providers[provider]) continue;
      for (const terms of macro) add(provider, [], terms, 5);
      for (const instrument of store.monitored()) {
        const priority = active.has(instrument.id) ? 100 : pins.has(instrument.id) ? 50 : 10;
        if (provider === 'marketaux' && instrument.market === 'equity')
          add(provider, [instrument.symbol], [], priority);
        else {
          const names = aliases
            .filter((a) => a.instrumentId === instrument.id)
            .map((a) => a.alias)
            .slice(0, 20);
          if (names.length) add(provider, [], names, priority);
        }
      }
    }
    // Reserve room for macro coverage even with a large monitored universe.
    const selected = [
      ...recipes.filter((r) => r.priority === 5),
      ...recipes
        .filter((r) => r.priority > 5)
        .sort((a, b) => b.priority - a.priority || a.query.id.localeCompare(b.query.id)),
    ].slice(0, NEWS_LIMITS.queries);
    store.transaction(() => {
      const wanted = new Set(selected.map((r) => r.query.id));
      const previous = store.db.prepare('SELECT id,lease_expires_at FROM news_queries').all() as {
        id: string;
        lease_expires_at: number | null;
      }[];
      for (const row of previous)
        if (!wanted.has(row.id) && (!row.lease_expires_at || row.lease_expires_at <= now))
          store.db.prepare('DELETE FROM news_queries WHERE id=?').run(row.id);
      for (const recipe of selected)
        store.db
          .prepare(
            'INSERT INTO news_queries(id,provider,specification,priority,due_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET priority=excluded.priority WHERE news_queries.priority<>excluded.priority',
          )
          .run(
            recipe.query.id,
            recipe.query.provider,
            JSON.stringify(recipe.query),
            recipe.priority,
            now,
          );
    });
  }
  claim(
    now: number,
    config: NewsConfig,
    available: Partial<Record<NewsProvider, boolean>>,
  ): { row: ScheduledQuery; query: NewsQuery; attemptId: string } | null {
    return this.news.store.transaction(() => {
      const store = this.news.store,
        slot = Math.floor(now / 60000);
      if (store.get('news_attempt_slot', -1) >= slot) return null;
      const smoke = store.db
        .prepare(
          "SELECT j.request_id,j.provider FROM news_smoke_jobs j JOIN news_smoke_requests r ON r.id=j.request_id WHERE j.status='pending' AND r.requested_at<=? AND r.expires_at>? ORDER BY r.requested_at,j.provider LIMIT 3",
        )
        .all(now, now) as { request_id: string; provider: NewsProvider }[];
      for (const job of smoke)
        if (!available[job.provider])
          store.db
            .prepare(
              "UPDATE news_smoke_jobs SET status='skipped',diagnostic='NEWS_CREDENTIAL_MISSING' WHERE request_id=? AND provider=?",
            )
            .run(job.request_id, job.provider);
      const rows = store.db
        .prepare(
          "SELECT * FROM news_queries WHERE status='ready' AND due_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY due_at-priority*60000,priority DESC,id LIMIT 64",
        )
        .all(now, now) as ScheduledQuery[];
      rows.sort(
        (a, b) =>
          Number(smoke.some((j) => j.provider === b.provider)) -
          Number(smoke.some((j) => j.provider === a.provider)),
      );
      for (const row of rows) {
        if (
          !available[row.provider] ||
          !config.providers[row.provider] ||
          !this.quota.available(row.provider, now, config.dailyCaps[row.provider])
        )
          continue;
        let domains = approvedDomains(this.news, row.provider, now);
        if (!domains.length) continue;
        if (row.provider === 'currents') {
          const cursor = store.get('news_currents_domain_cursor', 0);
          domains = [domains[cursor % domains.length]!];
          store.set('news_currents_domain_cursor', cursor + 1);
        } else domains = domains.slice(0, 20);
        const attemptId = randomUUID();
        let checkpoint: { through?: number }, specification: unknown;
        try {
          checkpoint = row.checkpoint ? (JSON.parse(row.checkpoint) as { through?: number }) : {};
          specification = JSON.parse(row.specification);
          if (!checkpoint || !specification || typeof specification !== 'object')
            throw new Error('invalid query');
        } catch {
          store.db.prepare("UPDATE news_queries SET status='suspended' WHERE id=?").run(row.id);
          continue;
        }
        const parsed = querySchema.safeParse({
          ...specification,
          domains,
          attemptId,
          startAt: Math.max(
            0,
            now - 86400000,
            Math.min(now - 900000, (checkpoint.through ?? now - 86400000) - 900000),
          ),
          endAt: now,
        });
        if (!parsed.success) {
          store.db.prepare("UPDATE news_queries SET status='suspended' WHERE id=?").run(row.id);
          continue;
        }
        if (
          !this.quota.reserve(row.provider, row.id, attemptId, now, config.dailyCaps[row.provider])
        )
          continue;
        store.db
          .prepare('UPDATE news_queries SET lease_id=?,lease_expires_at=? WHERE id=?')
          .run(attemptId, now + 20000, row.id);
        const job = smoke.find((j) => j.provider === row.provider);
        if (job)
          store.db
            .prepare(
              "UPDATE news_smoke_jobs SET status='attempted',attempt_id=? WHERE request_id=? AND provider=? AND status='pending'",
            )
            .run(attemptId, job.request_id, row.provider);
        store.set('news_attempt_slot', slot);
        return { row, query: parsed.data, attemptId };
      }
      return null;
    });
  }
  finish(
    row: ScheduledQuery,
    attemptId: string,
    now: number,
    checkpoint: {
      through: number;
      truncated: boolean;
      stored: number;
      suppressed: number;
      duplicates?: number;
    } | null,
    error: NewsError | null,
  ): void {
    const nextAt = Math.max(now + 60000, this.quota.state(row.provider).nextAt);
    this.news.store.db
      .prepare(
        "UPDATE news_smoke_jobs SET status=?,diagnostic=? WHERE attempt_id=? AND status='attempted'",
      )
      .run(error ? 'failed' : 'complete', error?.code ?? null, attemptId);
    this.news.store.db
      .prepare(
        'UPDATE news_queries SET lease_id=NULL,lease_expires_at=NULL,due_at=?,checkpoint=COALESCE(?,checkpoint),failures=?,status=? WHERE id=? AND lease_id=?',
      )
      .run(
        nextAt,
        checkpoint ? JSON.stringify(checkpoint) : null,
        error ? row.failures + 1 : 0,
        error?.code === 'NEWS_INVALID_QUERY' ? 'suspended' : 'ready',
        row.id,
        attemptId,
      );
  }
}
