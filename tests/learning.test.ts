import { expect, it } from 'vitest';
import { Store } from '../src/storage.js';
import { Learning } from '../src/learning.js';
import { defaults } from '../src/config.js';
import { advance, makeEvent, strategyVersion } from '../src/core/strategy.js';
import { fixture, idea } from './fixtures.js';
import type { SignalEvent } from '../src/domain.js';
import { learningFeatures } from '../src/core/learning-features.js';
import { currentReversal, saveReversal } from '../src/reversal-config.js';
import { reversalDetails, advanceReversal, type PendingReversal } from '../src/core/trackers.js';
import { trackerEvent } from '../src/watch-trackers.js';
const DAY = 86400000;
function entry(id: string, time: number, volume = 2): SignalEvent {
  const data = fixture(),
    initial = advance(idea(data), data, defaults, data.provenance.asOf);
  const e = structuredClone(initial.events.at(-1)!);
  e.id = `entry-${id}`;
  e.ideaId = id;
  e.marketTime = time;
  e.recordedAt = time;
  e.candidate.id = id;
  e.recovery = false;
  e.learning = {
    at: time,
    benchmarkTrend: 'up',
    benchmarkAgreement: true,
    breakoutRelativeVolume: volume,
    breakoutThreshold: 1.5,
    atr: 2,
  };
  return e;
}
function terminal(e: SignalEvent, state: SignalEvent['state'], changePercent = 1): SignalEvent {
  return {
    ...e,
    id: `end-${e.ideaId}`,
    state,
    marketTime: e.marketTime + 900000,
    recordedAt: e.marketTime + 900000,
    performance: {
      referencePrice: 101,
      changePercent,
      rMultiple: 1,
      reachedTargets: [],
      basis: 'completed_close',
      ambiguous: false,
    },
  };
}
function pair(
  store: Store,
  id: string,
  time: number,
  volume: number,
  state: SignalEvent['state'],
  change = 1,
) {
  const e = entry(id, time, volume);
  store.recordEvent(e);
  store.recordEvent(terminal(e, state, change));
  return e;
}
it.each(['bullish', 'bearish'] as const)(
  'freezes %s features using only completed benchmark and daily bars',
  (direction) => {
    const data = fixture(direction),
      time = data.daily.at(-1)!.end;
    const before = learningFeatures(data, time, direction);
    const future = {
      ...data.daily.at(-1)!,
      start: time,
      end: time + DAY,
      close: 999999,
      volume: 999999,
    };
    data.daily.push(future);
    data.benchmark.push(future);
    expect(learningFeatures(data, time, direction)).toEqual(before);
    const original = idea(data),
      e = makeEvent(
        original,
        'watching',
        original.candidate.breakout.end,
        data,
        time,
        [],
        undefined,
        defaults,
      );
    expect(e.learning!.at).toBe(e.marketTime);
    expect(e.candidate.retest).toBeUndefined();
  },
);
it('retains failures and exceptional successes, aggregates ordinary outcomes, and survives replay', () => {
  const store = new Store(':memory:');
  try {
    const now = fixture().provenance.asOf;
    pair(store, 'loss', now, 1.5, 'invalidated', -2);
    pair(store, 'ordinary', now, 2, 'time_exit', 2);
    pair(store, 'big', now, 2, 'time_exit', 10);
    pair(store, 'target', now, 2, 'final_target', 4);
    pair(store, 'expired', now, 2, 'expired', 0);
    const a = entry('ambiguous-real', now);
    store.recordEvent(a);
    store.recordEvent({
      ...terminal(a, 'invalidated', -3),
      observations: ['Target also touched; ordering unknown'],
      performance: { ...terminal(a, 'invalidated', -3).performance!, ambiguous: true },
    });
    const learning = new Learning(store);
    learning.process(now + DAY);
    expect(learning.cases().map((c) => c.id)).toHaveLength(3);
    expect(learning.cases().some((c) => c.callout.ideaId === 'ordinary')).toBe(false);
    expect(learning.cases().some((c) => c.callout.ideaId === 'ambiguous-real')).toBe(false);
    expect(learning.report()).toContain('unconfirmed 1');
    expect(learning.report()).toContain('ambiguous 1');
    const report = learning.report();
    new Learning(store).process(now + DAY);
    expect(learning.report()).toBe(report);
    expect(learning.status().pending).toBe(0);
  } finally {
    store.close();
  }
});
it('separates pre-entry failures from confirmed entries and ignores unreconstructable old events', () => {
  const store = new Store(':memory:');
  try {
    const now = fixture().provenance.asOf;
    const setup = {
      ...entry('setup', now),
      state: 'watching' as const,
      candidate: { ...entry('setup', now).candidate, entry: undefined },
    };
    store.recordEvent(setup);
    store.enqueue(terminal(setup, 'invalidated'), 'updates');
    const old = { ...entry('old', now), learning: undefined };
    store.recordEvent(old);
    store.recordEvent(terminal(old, 'invalidated', -2));
    const learn = new Learning(store);
    learn.process(now + 900000);
    expect(learn.cases()).toHaveLength(1);
    expect(learn.cases()[0]!.family).toBe('strategy_setup');
    const reviews = store.pending(now + DAY).filter((p) => p.event.kind === 'learning_review');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.event.learningText).toContain('Hypothesis to test');
    expect(reviews[0]!.event.sourceEventId).toBe('end-setup');
  } finally {
    store.close();
  }
});
it.each(['bullish', 'bearish'] as const)(
  'reviews cancelled %s reversals and keeps confirmation statistics separate',
  (direction) => {
    const store = new Store(':memory:');
    try {
      const data = fixture(direction),
        warning = data.intraday[0]!,
        now = warning.end;
      const p: PendingReversal = {
        id: 'warning',
        direction,
        high: 110,
        low: 90,
        warning,
        elapsed: 0,
        announced: true,
      };
      const w = trackerEvent(
        data,
        {
          id: 'warning',
          direction,
          bar: warning,
          details: reversalDetails(p, '15m', 'warning', warning.close),
        },
        now,
      );
      store.enqueue(w, 'watchlist');
      const close = direction === 'bullish' ? warning.low - 1 : warning.high + 1;
      const e = trackerEvent(
        data,
        {
          id: 'cancel',
          direction,
          bar: { ...warning, end: now + 900000, close },
          details: reversalDetails(p, '15m', 'cancelled', close),
        },
        now + 900000,
      );
      store.enqueue(e, 'watchlist');
      new Learning(store).process(now + 900000);
      expect(new Learning(store).cases()[0]!.family).toBe('reversal_warning');
      expect(
        store.pending(now + DAY).filter((p) => p.event.kind === 'learning_review'),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  },
);
it('proposes bounded filters, separates future evidence, accounts for blocked successes and promotes/rolls back', () => {
  const store = new Store(':memory:');
  try {
    const now = fixture().provenance.asOf;
    for (let i = 0; i < 20; i++)
      pair(
        store,
        `initial-${i}`,
        now,
        i < 10 ? 2 : 1.5,
        i < 10 ? 'time_exit' : 'invalidated',
        i < 10 ? 2 : -2,
      );
    const learning = new Learning(store);
    learning.process(now + DAY, 100);
    const experiments = learning.experiments();
    expect(experiments).toHaveLength(2);
    expect(experiments.every((e) => e.pass.success === 0 && e.blocked.failure === 0)).toBe(true);
    const proposal = experiments[0]!;
    expect(() => learning.promote(proposal.id, now + DAY)).toThrow('NOT_REVIEW_READY');
    for (let i = 0; i < 50; i++)
      pair(
        store,
        `future-${i}`,
        now + 2 * DAY,
        i < 25 ? 2 : 1.5,
        i % 2 ? 'time_exit' : 'invalidated',
        i % 2 ? 2 : -2,
      );
    learning.process(now + 30 * DAY, 200);
    const updated = learning.experiments().find((e) => e.id === proposal.id)!;
    expect(updated.blocked.success).toBeGreaterThan(0);
    expect(updated.blocked.failure).toBeGreaterThan(0);
    expect(learning.ready(updated, now + 30 * DAY)).toBe(true);
    const original = strategyVersion(store.strategy());
    const next = learning.promote(proposal.id, now + 30 * DAY);
    expect(next).not.toBe(original);
    expect(store.get('historical_replay_verified', true)).toBe(false);
    expect(store.version(original)).toEqual(defaults);
    expect(learning.rollback(proposal.id)).toBe(original);
    expect(store.strategy()).toEqual(defaults);
  } finally {
    store.close();
  }
});
it('reversal promotion stores immutable versions and pending warnings retain original rules', () => {
  const store = new Store(':memory:');
  try {
    const original = currentReversal(store);
    saveReversal(store, original.config);
    const pending: PendingReversal = {
      id: 'old-warning',
      direction: 'bullish',
      high: 110,
      low: 90,
      warning: { start: 0, end: 900000, open: 98, high: 101, low: 95, close: 99, volume: 1 },
      elapsed: 4,
      announced: true,
      strategyVersion: original.version,
      confirmationBars: 5,
    };
    const newVersion = saveReversal(store, { ...original.config, benchmarkAgreement: true });
    expect(newVersion).not.toBe(original.version);
    expect(
      store.db.prepare('SELECT body FROM reversal_versions WHERE version=?').get(original.version),
    ).toBeTruthy();
    const result = advanceReversal(pending, '15m', {
      ...pending.warning,
      start: 900000,
      end: 1800000,
      close: 100,
    });
    expect(result.observation?.details).toMatchObject({ phase: 'expired', confirmationBars: 5 });
    expect(pending.strategyVersion).toBe(original.version);
  } finally {
    store.close();
  }
});
it('bounds backfill, suppresses historical reviews and pauses independently of live signals', () => {
  const store = new Store(':memory:');
  try {
    const now = fixture().provenance.asOf;
    pair(store, 'historical', now, 1.5, 'invalidated', -2);
    const learning = new Learning(store);
    store.set('learning_paused', true);
    learning.process(now + 3 * DAY);
    expect(learning.status().backlog).toBe(2);
    store.set('learning_paused', false);
    learning.process(now + 3 * DAY, 1);
    expect(learning.status().backlog).toBe(1);
    learning.process(now + 3 * DAY, 1);
    expect(learning.cases()).toHaveLength(1);
    expect(store.pending(now + 3 * DAY)).toHaveLength(0);
    learning.process(now + 100 * DAY);
    expect(learning.cases()).toHaveLength(0);
    expect(store.journal().filter((e) => e.kind === 'lifecycle')).toHaveLength(2);
  } finally {
    store.close();
  }
});
it('posts only one weekly report after new outcomes and keeps complete report text', () => {
  const store = new Store(':memory:');
  try {
    const monday = Date.UTC(2026, 9, 5),
      learning = new Learning(store);
    learning.process(monday);
    pair(store, 'one', monday + DAY, 2, 'time_exit', 2);
    learning.process(monday + DAY);
    learning.process(monday + 7 * DAY);
    learning.process(monday + 7 * DAY);
    const reports = store
      .pending(monday + 8 * DAY)
      .filter((p) => p.event.kind === 'learning_report');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.event.learningText).toContain('Insufficient evidence');
    learning.process(monday + 14 * DAY);
    expect(
      store.pending(monday + 15 * DAY).filter((p) => p.event.kind === 'learning_report'),
    ).toHaveLength(1);
  } finally {
    store.close();
  }
});
it('prunes detailed cases by age and count without deleting ordinary callout history', () => {
  const store = new Store(':memory:');
  try {
    const now = Date.UTC(2026, 9, 7);
    for (let n = 0; n < 1005; n++)
      store.db
        .prepare('INSERT INTO learning_cases VALUES(?,?,?)')
        .run(`case-${n}`, now - 1005 + n, JSON.stringify({ id: `case-${n}` }));
    store.db
      .prepare('INSERT INTO learning_cases VALUES(?,?,?)')
      .run('old', now - 91 * DAY, JSON.stringify({ id: 'old' }));
    new Learning(store).process(now);
    expect(
      (store.db.prepare('SELECT count(*) AS n FROM learning_cases').get() as { n: number }).n,
    ).toBe(1000);
    expect(store.db.prepare('SELECT 1 FROM learning_cases WHERE id=?').get('old')).toBeUndefined();
    expect(
      store.db.prepare('SELECT 1 FROM learning_cases WHERE id=?').get('case-0'),
    ).toBeUndefined();
  } finally {
    store.close();
  }
});
it('promotes and rolls back a benchmark experiment with an immutable reversal version', () => {
  const store = new Store(':memory:');
  try {
    const now = fixture().provenance.asOf,
      version = currentReversal(store).version;
    const add = (id: string, time: number, aligned: boolean, failed: boolean) => {
      const base = entry(id, time),
        warning: SignalEvent = {
          ...base,
          id: `warning-${id}`,
          strategyVersion: version,
          kind: 'watch_tracker',
          state: 'watching',
          candidate: { ...base.candidate, entry: undefined },
          tracker: {
            type: 'reversal',
            phase: 'warning',
            timeframe: '15m',
            warningId: id,
            warningTime: time,
            warningClose: 100,
            close: 100,
            frozenHigh: 110,
            frozenLow: 90,
            cancellationLevel: 95,
            confirmationBars: 5,
            elapsed: 0,
          },
          learning: {
            at: time,
            benchmarkTrend: aligned ? 'up' : 'down',
            benchmarkAgreement: aligned,
          },
        };
      store.recordEvent(warning);
      store.recordEvent({
        ...warning,
        id: `end-${id}`,
        marketTime: time + 900000,
        tracker: {
          ...(warning.tracker as Extract<
            NonNullable<SignalEvent['tracker']>,
            { type: 'reversal' }
          >),
          phase: failed ? 'cancelled' : 'confirmed',
          elapsed: 1,
        },
      });
    };
    for (let n = 0; n < 20; n++) add(`initial-r-${n}`, now, n < 10, n >= 10);
    const learning = new Learning(store);
    learning.process(now + DAY, 100);
    const experiment = learning.experiments()[0]!;
    expect(experiment.filter).toBe('benchmark');
    for (let n = 0; n < 50; n++) add(`future-r-${n}`, now + 2 * DAY, n < 25, n % 2 === 0);
    learning.process(now + 30 * DAY, 200);
    const next = learning.promote(experiment.id, now + 30 * DAY);
    expect(currentReversal(store).config.benchmarkAgreement).toBe(true);
    expect(next).not.toBe(version);
    expect(learning.rollback(experiment.id)).toBe(version);
    expect(currentReversal(store).config.benchmarkAgreement).toBe(false);
  } finally {
    store.close();
  }
});
it('does not propose from insufficient failures or unknown filter features', () => {
  const store = new Store(':memory:');
  try {
    const now = fixture().provenance.asOf;
    for (let n = 0; n < 30; n++) {
      const e = entry(`low-evidence-${n}`, now, n < 15 ? 2 : 1.5);
      if (n >= 15) e.learning!.breakoutRelativeVolume = undefined;
      store.recordEvent(e);
      store.recordEvent(terminal(e, n < 4 ? 'invalidated' : 'time_exit', n < 4 ? -2 : 2));
    }
    const learning = new Learning(store);
    learning.process(now + DAY, 100);
    expect(learning.experiments()).toHaveLength(0);
  } finally {
    store.close();
  }
});
it('archives obsolete shadow experiments without changing original assignments or live idea levels', () => {
  const store = new Store(':memory:');
  try {
    const now = fixture().provenance.asOf;
    for (let n = 0; n < 20; n++)
      pair(
        store,
        `seed-${n}`,
        now,
        n < 10 ? 2 : 1.5,
        n < 10 ? 'time_exit' : 'invalidated',
        n < 10 ? 2 : -2,
      );
    const learning = new Learning(store);
    learning.process(now + DAY, 100);
    expect(learning.experiments()).toHaveLength(2);
    const e = entry('already-assigned', now + 2 * DAY, 1.5);
    store.recordEvent(e);
    learning.process(now + 2 * DAY, 100);
    store.saveStrategy({ ...defaults, breakoutVolume: 2 });
    learning.process(now + 3 * DAY);
    expect(learning.experiments().every((x) => x.status === 'superseded')).toBe(true);
    store.recordEvent(terminal(e, 'time_exit', 3));
    learning.process(now + 3 * DAY, 100);
    expect(learning.experiments().every((x) => x.blocked.success === 1)).toBe(true);
    expect(e.candidate.targets).toEqual(entry('reference', now).candidate.targets);
  } finally {
    store.close();
  }
});
it('marks discarded reversal histories unknown instead of inventing a failure', () => {
  const store = new Store(':memory:');
  try {
    const now = fixture().provenance.asOf,
      base = entry('lost-warning', now);
    const warning: SignalEvent = {
      ...base,
      kind: 'watch_tracker',
      strategyVersion: currentReversal(store).version,
      state: 'watching',
      tracker: {
        type: 'reversal',
        phase: 'warning',
        timeframe: '15m',
        warningId: base.ideaId,
        warningTime: now,
        close: 100,
        frozenHigh: 110,
        frozenLow: 90,
        cancellationLevel: 95,
        elapsed: 0,
        confirmationBars: 5,
      },
    };
    store.pin(warning.instrument);
    store.recordEvent(warning);
    const learning = new Learning(store);
    learning.process(now);
    expect(learning.status().pending).toBe(1);
    store.set(`tracker:v1:${warning.instrument.id}:15m`, { lastBar: now + 10 * 900000 });
    learning.process(now + DAY);
    expect(learning.status().pending).toBe(0);
    expect(learning.cases()).toHaveLength(0);
    expect(learning.report()).toContain('unknown 1');
    expect(store.pending(now + DAY)).toHaveLength(0);
  } finally {
    store.close();
  }
});
