import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.js';
import { ThresholdStore } from '../src/threshold/store.js';
import { ThresholdEngine } from '../src/threshold/engine.js';
import { HOUR } from '../src/threshold/core.js';
import { thresholdPublishable } from '../src/threshold/publication.js';
import { SignalService } from '../src/service.js';
import { Learning } from '../src/learning.js';
import { statistics } from '../src/insights.js';
import { open, mature, contract, thresholdFixture } from './threshold-fixtures.js';
import { QUARTER } from '../src/core/time.js';
import type { DataService } from '../src/data.js';

it('ships disabled and validates immutable numeric rule revisions', () => {
  const s = new Store(':memory:');
  try {
    const t = new ThresholdStore(s);
    expect(t.config()).toMatchObject({ enabled: false, ideas: false, contracts: false, hours: 4 });
    const id = t.revision();
    expect(() =>
      s.db.prepare('UPDATE threshold_rules SET body=? WHERE id=?').run('{}', id),
    ).toThrow('immutable');
    expect(() => s.db.prepare('DELETE FROM threshold_rules WHERE id=?').run(id)).toThrow(
      'immutable',
    );
  } finally {
    s.close();
  }
});
it('queues one qualifying stall atomically and records peak giveback without changing ideas', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    f.setBid(2.3);
    await f.tick(open + HOUR);
    f.setBid(1.94);
    await f.tick(mature);
    const e = f.pending()[0]!.event;
    expect(f.pending()).toHaveLength(1);
    expect(e.threshold!.observation).toMatchObject({
      eligible: true,
      returnPercent: expect.closeTo(-3),
      peakPercent: expect.closeTo(15),
    });
    expect(e.kind).toBe('threshold_alert');
    expect(e.strategyVersion).toMatch(/^threshold-v1-/);
    expect(f.state.get(m.id)?.pendingId).toBe(e.id);
    await f.tick(mature + 60000);
    expect(f.pending()).toHaveLength(1);
    f.store.transaction(() => {
      f.store.saveReceipt(e.id, 'updates', 'sent');
      f.state.delivered(e, mature);
      f.store.delivered(e.id);
    });
    f.setBid(1.7);
    await f.tick(mature + 120000);
    f.setBid(2.5);
    await f.tick(mature + 180000);
    expect(f.pending()).toHaveLength(0);
    expect(f.state.reviews(m.id)).toHaveLength(1);
    new Learning(f.store).process(mature);
    expect(statistics(f.store).groups).toHaveLength(0);
  } finally {
    f.store.close();
  }
});
it('does not prompt before four hours and resets only at cumulative 0.25 ATR progress', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    const frozen = f.state.get(m.id)!.frozenAtr;
    expect(frozen).toBe(4);
    await f.tick(open + 4 * HOUR);
    expect(f.pending()).toHaveLength(0);
    const at = open + QUARTER * 4;
    f.bars.find((b) => b.end === at)!.close = 100.4;
    f.bars.find((b) => b.end === at + QUARTER)!.close = 100.8;
    await f.tick(open + 2 * HOUR);
    expect(f.state.get(m.id)!.checkpoint).toBe(100);
    f.bars.find((b) => b.end === at + 2 * QUARTER)!.close = 101;
    // Restart the cursor to replay the newly supplied forward progression deterministically.
    const current = f.state.get(m.id)!;
    current.lastBar = at;
    f.state.save(current);
    await f.tick(mature);
    expect(f.state.get(m.id)!.checkpoint).toBe(101);
    expect(f.state.get(m.id)!.episode).toBe(2);
    expect(f.pending()).toHaveLength(0);
  } finally {
    f.store.close();
  }
});
it('suppresses pending prompts after progress, and rearms only for a later stall', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    await f.tick(mature);
    const old = f.pending()[0]!.event;
    const next = f.bars.find((b) => b.end === open + 5 * HOUR)!;
    next.close = 101;
    await f.tick(open + 5 * HOUR + 16 * 60000);
    expect(thresholdPublishable(f.store, old, open + 5 * HOUR + 16 * 60000)).toBe(false);
    expect(f.pending()).toHaveLength(0);
    expect(f.state.get(m.id)!.deliveredAllowance).toBe(-1);
    expect(f.state.get(m.id)!.progressAt).toBe(next.end);
  } finally {
    f.store.close();
  }
});
it('suspends valid stop breaches and permits explicit restart without recording a sale', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    f.setBid(1.5);
    await f.tick(mature);
    expect(f.state.get(m.id)).toMatchObject({
      status: 'suspended',
      observation: { reason: 'ENTERED_STOP_REFERENCE_REACHED' },
    });
    expect(f.pending()).toHaveLength(0);
    f.state.edit(m.id, {}, 'alice', false, mature + 1);
    expect(f.state.get(m.id)).toMatchObject({ status: 'active', needsReset: true });
  } finally {
    f.store.close();
  }
});
it('does not erase checkpoints for quote outages; shares one exact-symbol request per poll', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    f.add('bob');
    await f.tick(open);
    const before = f.state.get(m.id)!;
    f.optionQuotes.mockRejectedValueOnce(new Error('PROVIDER_WORK_LIMIT'));
    await f.tick(mature);
    expect(f.pending()).toHaveLength(0);
    expect(f.state.get(m.id)!.checkpoint).toBe(before.checkpoint);
    expect(f.state.get(m.id)!.needsReset).toBe(false);
    expect(f.store.get('threshold_deferred', null)).not.toBeNull();
    await f.tick(mature + 60000);
    expect(f.pending()).toHaveLength(2);
    expect(f.optionQuotes.mock.calls.at(-1)![0]).toEqual([contract]);
  } finally {
    f.store.close();
  }
});
it('rebaselines after outages over ten minutes, but preserves state across a routine restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'threshold-'));
  const f = thresholdFixture(join(dir, 'state.sqlite'));
  try {
    const m = f.add();
    await f.tick(open);
    await f.tick(mature);
    const e = f.pending()[0]!.event;
    f.store.close();
    const s = new Store(join(dir, 'state.sqlite'));
    try {
      const t = new ThresholdStore(s);
      expect(t.get(m.id)!.pendingId).toBe(e.id);
      await new ThresholdEngine(s, f.provider, () => 0).poll(
        new Map([[f.instrument.id, f.dataset(mature + 60000)]]),
        mature + 60000,
      );
      expect(t.get(m.id)!.episode).toBe(1);
      await new ThresholdEngine(s, f.provider, () => 0).poll(
        new Map([[f.instrument.id, f.dataset(mature + 12 * 60000)]]),
        mature + 12 * 60000,
      );
      expect(t.get(m.id)!.episode).toBe(2);
      expect(t.get(m.id)!.observation!.eligible).toBe(false);
      expect(
        s.pending(mature + 12 * 60000).filter((p) => p.event.kind === 'threshold_alert'),
      ).toHaveLength(0);
    } finally {
      s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('rebaselines on missing history, numeric changes and feature re-enabling; old rules remain immutable', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    await f.tick(mature);
    const old = f.state.get(m.id)!.revision;
    f.state.configure({ hours: 3 }, 'admin', mature);
    expect(f.pending()).toHaveLength(0);
    await f.tick(mature + 60000);
    expect(f.state.get(m.id)!.revision).not.toBe(old);
    expect(f.state.get(m.id)!.observation!.elapsedHours).toBe(0);
    f.state.configure({ enabled: false }, 'admin', mature + 60001);
    f.state.configure({ enabled: true }, 'admin', mature + 60002);
    expect(f.state.get(m.id)!.needsReset).toBe(true);
    await f.tick(mature + 120000);
    const index = f.bars.findIndex((b) => b.end === open + 4 * HOUR + QUARTER);
    f.bars.splice(index, 1);
    await f.tick(mature + 30 * 60000);
    expect(f.pending()).toHaveLength(0);
  } finally {
    f.store.close();
  }
});
it('rolls back cursor and outbox together if enqueue fails', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    const enqueue = vi.spyOn(f.store, 'enqueue').mockImplementation(() => {
      throw new Error('disk failed');
    });
    await expect(f.tick(mature)).rejects.toThrow('disk failed');
    expect(f.state.get(m.id)!.pendingId).toBeUndefined();
    expect(f.store.journal().filter((e) => e.kind === 'threshold_alert')).toHaveLength(0);
    enqueue.mockRestore();
    await f.tick(mature);
    expect(f.pending()).toHaveLength(1);
  } finally {
    f.store.close();
  }
});
it('allows only one explicit snooze reminder per allowance and retains unknown stopped outcomes', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    await f.tick(mature);
    const e = f.pending()[0]!.event;
    f.store.transaction(() => {
      f.state.delivered(e, mature);
      f.store.delivered(e.id);
    });
    f.state.snooze(m.id, 'alice', false, mature);
    await f.tick(mature + HOUR);
    expect(f.pending()).toHaveLength(0);
    await f.tick(mature + HOUR + 35 * 60000);
    expect(f.pending()).toHaveLength(1);
    expect(f.state.reviews(m.id)[0]!.oneHour?.returnPercent).toBe(0);
    const reminder = f.pending()[0]!.event;
    f.store.transaction(() => {
      f.state.delivered(reminder, mature + HOUR + 35 * 60000);
      f.store.delivered(reminder.id);
    });
    await f.tick(mature + HOUR + 36 * 60000);
    expect(f.pending()).toHaveLength(0);
    f.state.stop(m.id, 'alice', false, mature + HOUR + 37 * 60000);
    await f.tick(mature + HOUR + 38 * 60000);
    expect(
      f.state.reviews(m.id).every((r) => r.fourHours?.reason === 'MONITOR_ENDED_OR_DISABLED'),
    ).toBe(true);
  } finally {
    f.store.close();
  }
});
it.each(['bullish', 'bearish'] as const)(
  'seeds automatic %s ideas without history replay and retires terminal ideas',
  async (direction) => {
    const f = thresholdFixture();
    try {
      const idea = f.autoIdea(direction),
        original = structuredClone(idea);
      await f.tick(open);
      await f.tick(mature);
      expect(f.pending()).toHaveLength(1);
      expect(f.pending()[0]!.event.threshold!.monitor.mode).toBe('idea');
      expect(f.store.idea(idea.candidate.id)).toEqual(original);
      idea.state = 'time_exit';
      f.store.saveIdea(idea, [], false);
      await f.tick(mature + 60000);
      expect(f.pending()).toHaveLength(0);
      expect(f.state.all()).toHaveLength(0);
    } finally {
      f.store.close();
    }
  },
);
it('retains removed contract underlyings without generating ideas or watch trackers', async () => {
  const f = thresholdFixture();
  try {
    f.add();
    f.store.exclude(f.instrument);
    expect(f.store.baseMonitored()).toHaveLength(0);
    expect(f.store.monitored()).toEqual([f.instrument]);
    const text = f.store.journal().at(-1)!.announcement!.body;
    expect(text).toContain('active threshold contracts');
    expect(text).toContain('AAPL');
    f.store.set('last_scan', mature - 300000);
    f.store.set('discovery_day', '2026-10-20');
    const d = f.dataset(mature);
    const provider = {
      ...f.provider,
      refreshDaily: async () => {},
      refreshIntraday: async () => {},
      dataset: async () => d,
      universe: async () => [],
    } as unknown as DataService;
    await new SignalService(f.store, provider).scan(mature, false, true, false);
    expect(f.store.activeIdeas()).toHaveLength(0);
    expect(f.store.journal().filter((e) => e.kind === 'watch_tracker')).toHaveLength(0);
  } finally {
    f.store.close();
  }
});
it('expires contracts at regular-session close on expiry day', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add('alice', { contract: 'AAPL261020C00100000' });
    await f.tick(open);
    await f.tick(open + 6.5 * HOUR);
    expect(f.state.get(m.id)!.status).toBe('expired');
    expect(f.pending()).toHaveLength(0);
  } finally {
    f.store.close();
  }
});

it('expires queued/dead attempts independently of Discord availability so valid later prompts are not lost', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    await f.tick(mature);
    const old = f.pending()[0]!.event;
    f.store.db.prepare("UPDATE outbox SET status='dead' WHERE event_id=?").run(old.id);
    await f.tick(mature + 60000);
    const next = f.pending(mature + 60000)[0]!.event;
    expect(next.id).not.toBe(old.id);
    expect(
      f.store.db.prepare('SELECT status FROM outbox WHERE event_id=?').get(old.id),
    ).toMatchObject({ status: 'suppressed' });
    expect(f.state.get(m.id)!.deliveredAllowance).toBe(-1);
  } finally {
    f.store.close();
  }
});
it('reconciles durable receipts before a new poll without burning a future episode or reposting', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    await f.tick(mature);
    const old = f.pending()[0]!.event;
    f.store.saveReceipt(old.id, 'private', 'recovered-message');
    await f.tick(mature + 60000);
    expect(f.pending(mature + 60000)).toHaveLength(0);
    expect(f.state.get(m.id)!.deliveredAllowance).toBe(0);
    expect(f.state.reviews(m.id)).toHaveLength(1);
  } finally {
    f.store.close();
  }
});
it('re-reads owners edits after an asynchronous quote request instead of overwriting them', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    f.optionQuotes.mockImplementationOnce(async (_symbols, now) => {
      f.state.stop(m.id, 'alice', false, now);
      return [f.quote(now)];
    });
    await f.tick(mature);
    expect(f.state.get(m.id)!.status).toBe('stopped');
    expect(f.pending()).toHaveLength(0);
  } finally {
    f.store.close();
  }
});
it('uses confirmation-time ATR for fresh automatic entries without leaking later daily candles', async () => {
  const f = thresholdFixture();
  try {
    const idea = f.autoIdea(),
      now = open + HOUR,
      d = f.cache(now);
    d.daily.push({
      start: now,
      end: now + HOUR,
      open: 100,
      high: 10000,
      low: 1,
      close: 100,
      volume: 100,
    });
    await f.engine.poll(new Map([[f.instrument.id, d]]), now, new Set([idea.candidate.id]));
    const m = f.state.all()[0]!;
    expect(m.startedAt).toBe(open);
    expect(m.frozenAtr).toBe(4);
    expect(m.checkpoint).toBe(100);
    expect(f.pending(now)).toHaveLength(0);
  } finally {
    f.store.close();
  }
});
it('resets put progress on a meaningful underlying decline', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add('alice', { contract: 'AAPL261218P00100000' });
    await f.tick(open);
    f.bars.find((b) => b.end === open + HOUR)!.close = 99;
    await f.tick(open + 2 * HOUR);
    expect(f.state.get(m.id)!.checkpoint).toBe(99);
    expect(f.state.get(m.id)!.progressAt).toBe(open + HOUR);
    expect(f.state.get(m.id)!.episode).toBe(2);
  } finally {
    f.store.close();
  }
});

it('validates quotes against request-completion time, including provider latency', async () => {
  const f = thresholdFixture();
  try {
    f.add();
    await f.tick(open);
    let clock = 0;
    const now = mature,
      d = f.cache(now);
    for (const m of f.state.all()) {
      m.lastEvaluated = now - 300000;
      f.state.save(m);
    }
    f.optionQuotes.mockImplementationOnce(async () => {
      clock += 2000;
      return [{ ...f.quote(now), asOf: now + 1000 }];
    });
    await new ThresholdEngine(f.store, f.provider, () => clock).poll(
      new Map([[f.instrument.id, d]]),
      now,
    );
    expect(f.pending(now + 2000)).toHaveLength(1);
    expect(f.pending(now + 2000)[0]!.event.threshold!.observation.evaluatedAt).toBe(now + 2000);
  } finally {
    f.store.close();
  }
});
it('uses distinct registration identities even when a contract is stopped and re-added in the same millisecond', () => {
  const f = thresholdFixture();
  try {
    const first = f.add();
    f.state.stop(first.id, 'alice', false, open);
    const second = f.add();
    expect(second.id).not.toBe(first.id);
    expect(f.state.get(first.id)!.status).toBe('stopped');
    expect(f.state.get(second.id)!.status).toBe('active');
  } finally {
    f.store.close();
  }
});

it('tracks crypto ideas through continuous overnight time at the exact four-hour boundary', async () => {
  const f = thresholdFixture();
  try {
    const { crypto } = await import('../src/domain.js');
    const instrument = crypto('ETH-USD'),
      start = Date.parse('2026-10-20T00:00:00Z');
    const idea = f.autoIdea();
    idea.candidate.instrument = instrument;
    idea.candidate.confirmedAt = start;
    f.store.saveIdea(idea, [], false);
    const data = {
      ...f.dataset(open),
      instrument,
      sessions: [],
      intraday: Array.from({ length: 17 }, (_, n) => ({
        start: start + (n - 1) * QUARTER,
        end: start + n * QUARTER,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 100,
      })),
      provenance: {
        provider: 'Synthetic Coinbase',
        feed: 'synthetic',
        delayMinutes: 0,
        asOf: start,
      },
    };
    data.intraday = data.intraday.filter((b) => b.end <= start);
    await f.engine.poll(new Map([[instrument.id, data]]), start, new Set([idea.candidate.id]));
    const m = f.state.all().find((m) => m.mode === 'idea')!;
    m.lastEvaluated = start + 4 * HOUR - 300000;
    f.state.save(m);
    data.intraday = Array.from({ length: 17 }, (_, n) => ({
      start: start + (n - 1) * QUARTER,
      end: start + n * QUARTER,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    await f.engine.poll(new Map([[instrument.id, data]]), start + 4 * HOUR);
    expect(f.pending(start + 4 * HOUR)).toHaveLength(1);
    expect(f.pending(start + 4 * HOUR)[0]!.event.threshold!.observation.elapsedHours).toBe(4);
  } finally {
    f.store.close();
  }
});
