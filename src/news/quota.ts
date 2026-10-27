import { countNewsMetrics } from './metrics.js';
import { NEWS_CAPS } from './config.js';
import type { NewsStore } from './store.js';
import type { NewsPage, NewsProvider } from './types.js';
import { timestampSchema } from './validation.js';
import { NewsError } from './transport.js';
export const NEWS_TARGETS = { marketaux: 24, currents: 36, gdelt: 12 } as const;
export interface ProviderState {
  failures: number;
  nextAt: number;
  blockedUntil: number;
  remaining: number | null;
  remainingDay: string;
  suspended: boolean;
  credentialHash: string;
  diagnostic: string | null;
}
const dayOf = (now: number) => new Date(timestampSchema.parse(now)).toISOString().slice(0, 10);
export function nextUtcDay(now: number): number {
  return Date.parse(`${dayOf(now)}T00:00:00Z`) + 86400000;
}
export class NewsQuota {
  constructor(readonly news: NewsStore) {}
  state(provider: NewsProvider): ProviderState {
    return this.news.store.get(`news_provider:${provider}`, {
      failures: 0,
      nextAt: 0,
      blockedUntil: 0,
      remaining: null,
      remainingDay: '',
      suspended: false,
      credentialHash: '',
      diagnostic: null,
    });
  }
  credential(provider: NewsProvider, hash: string, configured = true): void {
    const state = this.state(provider);
    if (!configured) {
      if (state.diagnostic !== 'NEWS_CREDENTIAL_MISSING')
        this.news.store.set(`news_provider:${provider}`, {
          ...state,
          suspended: true,
          diagnostic: 'NEWS_CREDENTIAL_MISSING',
        });
      return;
    }
    if (state.credentialHash === hash && state.diagnostic !== 'NEWS_CREDENTIAL_MISSING') return;
    // Key rotation can clear an auth suspension, but cannot reset quota/backoff.
    state.credentialHash = hash;
    if (
      state.diagnostic === 'NEWS_AUTH_FAILED' ||
      state.diagnostic === 'NEWS_ACCESS_DENIED' ||
      state.diagnostic === 'NEWS_CREDENTIAL_MISSING'
    ) {
      state.suspended = false;
      state.diagnostic = null;
    }
    this.news.store.set(`news_provider:${provider}`, state);
  }
  available(provider: NewsProvider, now: number, cap: number): boolean {
    const state = this.state(provider),
      day = dayOf(now);
    const row = this.news.store.db
      .prepare('SELECT attempts FROM news_quota_days WHERE provider=? AND day=?')
      .get(provider, day) as { attempts: number } | undefined;
    return (
      !state.suspended &&
      state.nextAt <= now &&
      state.blockedUntil <= now &&
      !(state.remainingDay === day && state.remaining === 0) &&
      (row?.attempts ?? 0) < Math.min(cap, NEWS_CAPS[provider])
    );
  }
  reserve(
    provider: NewsProvider,
    queryId: string,
    attemptId: string,
    now: number,
    cap: number,
  ): boolean {
    if (!Number.isInteger(cap) || cap < 0 || cap > NEWS_CAPS[provider])
      throw new NewsError('NEWS_INVALID_QUERY');
    return this.news.store.transaction(() => {
      const db = this.news.store.db,
        day = dayOf(now);
      if (
        db.prepare('SELECT id FROM news_quota_reservations WHERE id=?').get(attemptId) ||
        !this.available(provider, now, cap)
      )
        return false;
      db.prepare(
        'INSERT INTO news_quota_days(provider,day,attempts) VALUES(?,?,1) ON CONFLICT(provider,day) DO UPDATE SET attempts=attempts+1',
      ).run(provider, day);
      db.prepare(
        'INSERT INTO news_quota_reservations(id,provider,day,query_id,reserved_at) VALUES(?,?,?,?,?)',
      ).run(attemptId, provider, day, queryId, now);
      const state = this.state(provider);
      countNewsMetrics(this.news, now, { attempts: 1, retries: (state.failures ?? 0) > 0 ? 1 : 0 });
      state.nextAt = now + 86400000 / NEWS_TARGETS[provider];
      if (state.remainingDay === day && state.remaining !== null)
        state.remaining = Math.max(0, state.remaining - 1);
      this.news.store.set(`news_provider:${provider}`, state);
      return true;
    });
  }
  complete(
    provider: NewsProvider,
    attemptId: string,
    now: number,
    quota: NewsPage['quota'] | null,
    error: NewsError | null,
    failures = 0,
  ): void {
    this.news.store.transaction(() => {
      const reservation = this.news.store.db
        .prepare('SELECT status FROM news_quota_reservations WHERE id=? AND provider=?')
        .get(attemptId, provider) as { status: string } | undefined;
      if (reservation?.status !== 'reserved') return;
      const state = this.state(provider);
      if (quota?.remaining !== null && quota?.remaining !== undefined) {
        state.remaining = quota.remaining;
        state.remainingDay = dayOf(now);
      }
      if (error?.remaining !== null && error?.remaining !== undefined) {
        state.remaining = error.remaining;
        state.remainingDay = dayOf(now);
      }
      state.blockedUntil = Math.max(state.blockedUntil, quota?.retryAt ?? 0, error?.retryAt ?? 0);
      if (quota?.exhausted || error?.code === 'NEWS_PROVIDER_EXHAUSTED')
        state.blockedUntil = Math.max(state.blockedUntil, nextUtcDay(now));
      if (error) {
        countNewsMetrics(this.news, now, { failures: 1 });
        const streak = Math.max(failures, state.failures ?? 0);
        state.failures = streak + 1;
        state.diagnostic = error.code;
        if (error.code === 'NEWS_AUTH_FAILED' || error.code === 'NEWS_ACCESS_DENIED')
          state.suspended = true;
        state.nextAt = Math.max(
          now + Math.min(3600000, 60000 * 2 ** Math.min(streak, 6)),
          state.blockedUntil,
        );
      } else {
        state.diagnostic = null;
        state.failures = 0;
      }
      this.news.store.set(`news_provider:${provider}`, state);
      this.news.store.db
        .prepare(
          "UPDATE news_quota_reservations SET status=?,completed_at=? WHERE id=? AND provider=? AND status='reserved'",
        )
        .run(error ? 'failed' : 'complete', now, attemptId, provider);
    });
  }
}
