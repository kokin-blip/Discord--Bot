import { it, expect } from 'vitest';
import { Store } from '../src/storage.js';
import { equity } from '../src/domain.js';
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
