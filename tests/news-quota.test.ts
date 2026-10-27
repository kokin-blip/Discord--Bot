import { expect, it } from 'vitest';
import { Store } from '../src/storage.js';
import { NewsStore } from '../src/news/store.js';
import { NewsQuota, nextUtcDay } from '../src/news/quota.js';
import { NewsError } from '../src/news/transport.js';
import { now } from './news-fixtures.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('enforces reduced caps, rejects increases, counts attempts before completion and never refunds', () => {
  const s = new Store(':memory:');
  try {
    const q = new NewsQuota(new NewsStore(s, now));
    expect(q.reserve('marketaux', 'q', 'a1', now, 1)).toBe(true);
    expect(q.reserve('marketaux', 'q', 'a1', now, 1)).toBe(false);
    q.complete('marketaux', 'a1', now, null, new NewsError('NEWS_TIMEOUT'));
    expect(q.reserve('marketaux', 'q', 'a2', now + 3600000, 1)).toBe(false);
    expect(() => q.reserve('marketaux', 'q', 'a2', now, 61)).toThrow('NEWS_INVALID_QUERY');
    expect(q.reserve('marketaux', 'q', 'a3', nextUtcDay(now), 1)).toBe(true);
  } finally {
    s.close();
  }
});
it('persists uncertain reservations and concurrent callers across a database restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-quota-')),
    path = join(dir, 'db.sqlite');
  let s = new Store(path);
  try {
    let q = new NewsQuota(new NewsStore(s, now));
    expect(q.reserve('currents', 'q', 'crashed', now, 1)).toBe(true);
    s.close();
    s = new Store(path);
    q = new NewsQuota(new NewsStore(s, now));
    const second = new NewsQuota(new NewsStore(s, now));
    expect(q.reserve('currents', 'q', 'crashed', now + 3600000, 1)).toBe(false);
    expect(second.reserve('currents', 'q', 'other', now + 3600000, 1)).toBe(false);
    expect(
      s.db.prepare('SELECT status FROM news_quota_reservations WHERE id=?').get('crashed'),
    ).toEqual({ status: 'reserved' });
  } finally {
    s.close();
    rmSync(dir, { recursive: true });
  }
});
it('carries Retry-After across midnight and honors provider exhaustion feedback', () => {
  const s = new Store(':memory:');
  try {
    const q = new NewsQuota(new NewsStore(s, now));
    q.reserve('gdelt', 'q', 'a', now, 30);
    const until = nextUtcDay(now) + 3600000;
    q.complete('gdelt', 'a', now, null, new NewsError('NEWS_RATE_LIMITED', until));
    expect(q.available('gdelt', nextUtcDay(now), 30)).toBe(false);
    expect(q.available('gdelt', until, 30)).toBe(true);
    q.reserve('marketaux', 'q', 'b', now, 60);
    q.complete('marketaux', 'b', now, { remaining: 0, exhausted: true, retryAt: null }, null);
    expect(q.available('marketaux', now + 3600000, 60)).toBe(false);
    expect(q.available('marketaux', nextUtcDay(now), 60)).toBe(true);
  } finally {
    s.close();
  }
});
it('clears only credential suspensions on rotation without resetting quota or provider restrictions', () => {
  const s = new Store(':memory:');
  try {
    const q = new NewsQuota(new NewsStore(s, now));
    q.credential('currents', 'hash-one');
    q.reserve('currents', 'q', 'a', now, 1);
    q.complete('currents', 'a', now, null, new NewsError('NEWS_AUTH_FAILED', now + 7200000));
    q.credential('currents', 'hash-one');
    expect(q.state('currents').suspended).toBe(true);
    q.credential('currents', 'hash-two');
    expect(q.state('currents').suspended).toBe(false);
    expect(q.available('currents', now + 3600000, 100)).toBe(false);
    expect(q.available('currents', now + 7200000, 1)).toBe(false);
    q.credential('marketaux', 'no-key', false);
    expect(q.state('marketaux').diagnostic).toBe('NEWS_CREDENTIAL_MISSING');
    q.credential('marketaux', 'key-present');
    expect(q.state('marketaux').suspended).toBe(false);
  } finally {
    s.close();
  }
});
it('enforces every hard daily cap even during repeated retries', () => {
  const s = new Store(':memory:');
  try {
    const q = new NewsQuota(new NewsStore(s, now));
    for (const [provider, cap] of [
      ['marketaux', 60],
      ['currents', 100],
      ['gdelt', 30],
    ] as const) {
      for (let index = 0; index < cap; index++) {
        const time = now + index * 60000;
        // Different failing queries cannot bypass the persisted provider/day count.
        s.set(`news_provider:${provider}`, { ...q.state(provider), nextAt: time, failures: 0 });
        expect(q.reserve(provider, `q-${index}`, `${provider}-${index}`, time, cap)).toBe(true);
        q.complete(provider, `${provider}-${index}`, time, null, new NewsError('NEWS_TIMEOUT'));
      }
      expect(q.reserve(provider, 'extra', `${provider}-extra`, now + 7 * 3600000, cap)).toBe(false);
    }
    expect(
      (s.db.prepare('SELECT COUNT(*) AS n FROM news_quota_reservations').get() as { n: number }).n,
    ).toBe(190);
  } finally {
    s.close();
  }
});
