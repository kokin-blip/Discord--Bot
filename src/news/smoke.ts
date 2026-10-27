import type { NewsStore } from './store.js';
import { approvedDomains } from './scheduler.js';
import type { NewsProvider } from './types.js';
export function requestNewsSmoke(
  news: NewsStore,
  id: string,
  now: number,
  mode: 'test' | 'production',
): NewsProvider[] {
  if (mode !== 'test' || !news.config().enabled || !id || id.length > 256)
    throw new Error('NEWS_SMOKE_TEST_MODE_REQUIRED');
  return news.store.transaction(() => {
    if (news.store.db.prepare('SELECT id FROM news_smoke_requests WHERE id=?').get(id)) return [];
    const pending = news.store.db
      .prepare(
        "SELECT 1 FROM news_smoke_jobs j JOIN news_smoke_requests r ON r.id=j.request_id WHERE j.status IN ('pending','attempted') AND r.expires_at>? LIMIT 1",
      )
      .get(now);
    if (pending) throw new Error('NEWS_SMOKE_PENDING');
    const providers = (['marketaux', 'currents', 'gdelt'] as const).filter(
      (p) => news.config().providers[p] && approvedDomains(news, p, now).length > 0,
    );
    if (!providers.length) throw new Error('NEWS_STORAGE_DENIED');
    news.store.db
      .prepare('INSERT INTO news_smoke_requests VALUES(?,?,?)')
      .run(id, now, now + 86400000);
    for (const provider of providers)
      news.store.db
        .prepare('INSERT INTO news_smoke_jobs(request_id,provider,status) VALUES(?,?,?)')
        .run(id, provider, 'pending');
    return providers;
  });
}
export function smokeStatus(news: NewsStore) {
  return news.store.db
    .prepare(
      'SELECT r.id,r.requested_at,r.expires_at,j.provider,j.status,j.attempt_id,j.diagnostic FROM (SELECT * FROM news_smoke_requests ORDER BY requested_at DESC,id DESC LIMIT 10) r JOIN news_smoke_jobs j ON j.request_id=r.id ORDER BY r.requested_at DESC,j.provider LIMIT 30',
    )
    .all();
}
export function recoverSmoke(news: NewsStore, now: number): void {
  news.store.db
    .prepare(
      "UPDATE news_smoke_jobs SET status='uncertain',diagnostic='NEWS_SMOKE_UNCERTAIN' WHERE status='attempted' AND EXISTS (SELECT 1 FROM news_quota_reservations r WHERE r.id=news_smoke_jobs.attempt_id AND r.reserved_at<? AND r.status='reserved')",
    )
    .run(now - 20000);
  news.store.db
    .prepare(
      "UPDATE news_smoke_jobs SET status='skipped',diagnostic='NEWS_SMOKE_EXPIRED' WHERE status='pending' AND EXISTS (SELECT 1 FROM news_smoke_requests r WHERE r.id=news_smoke_jobs.request_id AND r.expires_at<=?)",
    )
    .run(now);
  const expired = news.store.db
    .prepare('SELECT id FROM news_smoke_requests WHERE expires_at<? ORDER BY expires_at LIMIT 100')
    .all(now - 90 * 86400000) as { id: string }[];
  for (const row of expired) {
    news.store.db.prepare('DELETE FROM news_smoke_jobs WHERE request_id=?').run(row.id);
    news.store.db.prepare('DELETE FROM news_smoke_requests WHERE id=?').run(row.id);
  }
}
