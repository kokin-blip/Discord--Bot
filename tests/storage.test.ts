import { it, expect } from 'vitest';
import { Store } from '../src/storage.js';
import { equity, crypto } from '../src/domain.js';
import { fixture, idea } from './fixtures.js';
import { advance } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('persists exclusions, pins, limits, and active ideas outside the watchlist', () => {
  const s = new Store(':memory:');
  try {
    for (let n = 0; n < 10; n++) s.pin(equity(`S${n}`));
    expect(() => s.pin(equity('ELEVEN'))).toThrow();
    s.selectAuto([equity('AUTO')]);
    s.exclude(equity('AUTO'));
    s.selectAuto([equity('AUTO')]);
    expect(s.monitored().some((i) => i.symbol === 'AUTO')).toBe(false);
    s.restore(equity('AUTO'));
    s.selectAuto([equity('AUTO')]);
    expect(s.monitored().some((i) => i.symbol === 'AUTO')).toBe(true);
    const d = fixture(),
      r = advance(idea(d), d, defaults, d.provenance.asOf);
    s.saveIdea(r.idea, r.events);
    s.exclude(d.instrument);
    expect(s.monitored().some((i) => i.symbol === 'ETH-USD')).toBe(true);
  } finally {
    s.close();
  }
});
it('keeps an append-only journal and deduplicates the outbox across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-store-')),
    path = join(dir, 'db.sqlite');
  let s = new Store(path);
  try {
    const d = fixture(),
      r = advance(idea(d), d, defaults, d.provenance.asOf);
    s.saveIdea(r.idea, r.events);
    s.saveIdea(r.idea, r.events);
    expect(s.pendingCount()).toBe(2);
    expect(() => s.db.exec('DELETE FROM events')).toThrow('append-only');
    expect(() => s.db.exec("UPDATE events SET body='{}'")).toThrow('append-only');
    s.delivered(r.events[0]!.id);
    s.saveReceipt(r.events[0]!.id, 'channel', 'message-one');
    s.saveReceipt(r.events[0]!.id, 'channel', 'message-two');
    s.close();
    s = new Store(path);
    expect(s.pendingCount()).toBe(1);
    expect(s.receipt(r.events[0]!.id, 'channel')).toBe('message-one');
    expect(s.idea(r.idea.candidate.id)!.candidate.entry).toBe(112.5);
  } finally {
    s.close();
    rmSync(dir, { recursive: true });
  }
});
it('journals recovery events without enqueuing stale entries', () => {
  const s = new Store(':memory:');
  try {
    const d = fixture(),
      r = advance(idea(d), d, defaults, d.provenance.asOf);
    r.events.forEach((e) => (e.recovery = true));
    s.saveIdea(r.idea, r.events);
    expect(s.journal()).toHaveLength(2);
    expect(s.pendingCount()).toBe(0);
  } finally {
    s.close();
  }
});
it('preserves strategy versions for existing ideas', () => {
  const s = new Store(':memory:');
  try {
    const old = s.strategy(),
      version = idea().candidate.strategyVersion;
    s.saveStrategy({ ...old, minimumRR: 4 });
    expect(s.version(version).minimumRR).toBe(3);
    expect(s.strategy().minimumRR).toBe(4);
  } finally {
    s.close();
  }
});
it('requires fresh review and soak after changing strategy thresholds', () => {
  const s = new Store(':memory:');
  try {
    s.set('historical_replay_verified', true);
    s.set('soak_start', 1);
    s.saveStrategy({ ...s.strategy(), minimumRR: 4 });
    expect(s.get('historical_replay_verified', true)).toBe(false);
    expect(s.get('soak_start', 1)).toBe(0);
  } finally {
    s.close();
  }
});
it.each(['equity', 'crypto'] as const)(
  'routes %s confirmed entries separately from setups and exits',
  (market) => {
    const s = new Store(':memory:');
    try {
      const data = fixture(),
        r = advance(idea(data), data, defaults, data.provenance.asOf);
      const instrument = market === 'equity' ? equity('TEST') : crypto('ETH-USD');
      const entry = {
        ...r.events.at(-1)!,
        recovery: false,
        instrument,
        candidate: { ...r.idea.candidate, instrument },
      };
      const setup = {
        ...entry,
        id: 'setup',
        state: 'setup_ready' as const,
        candidate: { ...entry.candidate, entry: undefined },
      };
      const exit = { ...entry, id: 'exit', state: 'invalidated' as const };
      s.saveIdea({ ...r.idea, candidate: entry.candidate }, [setup, entry, exit]);
      const routes = Object.fromEntries(
        s.pending(data.provenance.asOf).map((p) => [p.event.id, p.route]),
      );
      expect(routes).toEqual({
        setup: market === 'equity' ? 'equity_ideas' : 'crypto_ideas',
        [entry.id]: 'entries',
        exit: 'updates',
      });
      s.saveIdea(r.idea, [entry]);
      expect(s.pendingCount()).toBe(3);
    } finally {
      s.close();
    }
  },
);
it('migrates only unsent legacy entries and preserves receipts, retry state and non-entry routes', () => {
  const s = new Store(':memory:');
  try {
    const data = fixture(),
      r = advance(idea(data), data, defaults, data.provenance.asOf);
    const base = { ...r.events.at(-1)!, recovery: false };
    for (const id of ['unsent', 'dead', 'receipted', 'delivered'])
      s.enqueue({ ...base, id }, 'crypto_ideas');
    s.enqueue({ ...base, id: 'setup', state: 'setup_ready' }, 'crypto_ideas');
    s.enqueue({ ...base, id: 'reversal', kind: 'watch_tracker' }, 'watchlist');
    s.saveReceipt('receipted', 'old-ideas', 'original');
    s.delivered('delivered');
    s.db
      .prepare(
        "UPDATE outbox SET status='dead',attempts=10,next_attempt=12345 WHERE event_id='dead'",
      )
      .run();
    s.migrateEntryRoutes();
    const rows = s.db
      .prepare('SELECT event_id,route,status,attempts,next_attempt FROM outbox')
      .all() as {
      event_id: string;
      route: string;
      status: string;
      attempts: number;
      next_attempt: number;
    }[];
    const byId = Object.fromEntries(rows.map((row) => [row.event_id, row]));
    expect(byId.unsent).toMatchObject({ route: 'entries', status: 'pending' });
    expect(byId.dead).toMatchObject({
      route: 'entries',
      status: 'dead',
      attempts: 10,
      next_attempt: 12345,
    });
    expect(byId.receipted).toMatchObject({ route: 'crypto_ideas', status: 'pending' });
    expect(byId.delivered).toMatchObject({ route: 'crypto_ideas', status: 'delivered' });
    expect(byId.setup!.route).toBe('crypto_ideas');
    expect(byId.reversal!.route).toBe('watchlist');
    expect(s.receipt('receipted', 'old-ideas')).toBe('original');
    s.migrateEntryRoutes();
    expect(
      s.db.prepare('SELECT event_id,route,status,attempts,next_attempt FROM outbox').all(),
    ).toEqual(rows);
  } finally {
    s.close();
  }
});
