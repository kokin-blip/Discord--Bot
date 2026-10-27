import { expect, it } from 'vitest';
import { Store } from '../src/storage.js';
import { defaults } from '../src/config.js';
import { advance } from '../src/core/strategy.js';
import { fixture, idea } from './fixtures.js';
import { DAY, QUARTER } from '../src/core/time.js';
import {
  beginMovement,
  observeMovement,
  finishDiagnostics,
  LearningDiagnostics,
} from '../src/learning-diagnostics.js';
import { LearningObservations, sampleId } from '../src/learning-observations.js';
import { Learning } from '../src/learning.js';
import type { Bar, SignalEvent } from '../src/domain.js';
const start = Date.parse('2026-02-01T00:00:00Z');
function event(direction: 'bullish' | 'bearish' = 'bullish'): SignalEvent {
  const data = fixture(direction);
  const event = structuredClone(
    advance(idea(data), data, defaults, data.provenance.asOf).events.at(-1)!,
  );
  Object.assign(event, {
    id: 'call',
    ideaId: 'idea',
    marketTime: start,
    recordedAt: start,
    direction,
    recovery: false,
  });
  Object.assign(event.candidate, {
    id: 'idea',
    entry: 100,
    level: direction === 'bullish' ? 90 : 110,
    target: direction === 'bullish' ? 130 : 70,
    atr: 12.5,
  });
  event.learning = { at: start, close: 100, benchmarkTrend: 'up', benchmarkAgreement: true };
  event.performance = undefined;
  event.provenance = {
    provider: 'Alpaca',
    feed: 'SIP unit test data',
    delayMinutes: 0,
    asOf: start,
  };
  return event;
}
const bar = (n: number, high: number, low: number, close = 100): Bar => ({
  start: start + n * QUARTER,
  end: start + (n + 1) * QUARTER,
  open: 100,
  high,
  low,
  close,
  volume: 1,
});
it.each(['bullish', 'bearish'] as const)(
  'measures %s excursions, time to extremes, and reversal tags without including the entry candle',
  (direction) => {
    const callout = event(direction),
      sign = direction === 'bullish' ? 1 : -1;
    const movement = beginMovement(callout, 'strategy_entry', 12.5);
    observeMovement(movement, callout, { ...bar(-1, 9999, 0.1) });
    const first = direction === 'bullish' ? bar(0, 110, 98, 105) : bar(0, 102, 90, 95);
    const second = direction === 'bullish' ? bar(1, 106, 88, 89) : bar(1, 112, 94, 111);
    observeMovement(movement, callout, first);
    observeMovement(movement, callout, second);
    const terminal = { ...callout, state: 'invalidated' as const, marketTime: second.end };
    const result = finishDiagnostics(
      'sample',
      callout,
      'strategy_entry',
      movement,
      terminal,
      undefined,
      second.end,
    );
    expect(result.coverage).toBe('complete');
    expect(result.completedBars).toBe(2);
    expect(result.favorable).toMatchObject({
      percent: 10,
      r: 1,
      at: first.end,
      barsAfterCallout: 1,
      elapsedMs: QUARTER,
    });
    expect(result.adverse).toMatchObject({
      percent: 12,
      r: 1.2,
      at: second.end,
      barsAfterCallout: 2,
    });
    expect(result.referenceR).toBeCloseTo(-1.1);
    expect(result.directionalReferencePercent).toBeCloseTo(sign * (second.close - 100));
    expect(result.tags).toEqual([
      'immediate_invalidation',
      'favorable_then_reversed',
      'near_chase_limit',
    ]);
  },
);
it.each([4.999, 5])(
  'uses the strict 0.5R follow-through boundary at a favorable excursion of %s',
  (highGain) => {
    const callout = event();
    const movement = beginMovement(callout, 'strategy_entry', 12.501);
    const candle = bar(0, 100 + highGain, 99, 101);
    observeMovement(movement, callout, candle);
    const result = finishDiagnostics(
      'sample',
      callout,
      'strategy_entry',
      movement,
      { ...callout, state: 'time_exit', marketTime: candle.end },
      undefined,
      candle.end,
    );
    expect(result.tags.includes('insufficient_follow_through')).toBe(highGain < 5);
    expect(result.tags).not.toContain('near_chase_limit');
    expect(result.terminalReason).toBe('time_exit_positive');
  },
);
it('leaves R absent for setups and reversals, and discloses ambiguous or incomplete observations', () => {
  const callout = event();
  const movement = beginMovement(callout, 'strategy_setup');
  const candle = bar(0, 135, 85, 100);
  observeMovement(movement, callout, candle);
  const result = finishDiagnostics(
    'setup',
    callout,
    'strategy_setup',
    movement,
    {
      ...callout,
      state: 'entry_triggered',
      marketTime: candle.end,
      observations: ['Ordering unknown'],
    },
    undefined,
    candle.end,
  );
  expect(result.referenceR).toBeUndefined();
  expect(result.favorable?.r).toBeUndefined();
  expect(result.favorable?.percent).toBe(35);
  expect(result.ambiguousOrdering).toBe(true);
  expect(result.terminalReason).toBe('setup_qualified');
  const missing = finishDiagnostics(
    'missing',
    callout,
    'strategy_entry',
    beginMovement(callout, 'strategy_entry'),
    { ...callout, state: 'invalidated', marketTime: candle.end },
    'Missing expected completed candle',
    candle.end,
  );
  expect(missing.coverage).toBe('unavailable');
  expect(missing.tags).not.toContain('immediate_invalidation');
  expect(missing.coverageReasons).toContain('Missing expected completed candle');
});
it('persists diagnostics separately from the outcome journal and exposes them in cases and reviews', () => {
  const store = new Store(':memory:');
  try {
    const callout = event();
    const candle = bar(0, 105, 88, 89);
    store.cache(callout.instrument, '15m', [candle]);
    store.enqueue(callout, 'crypto_ideas');
    store.saveReceipt(callout.id, 'channel', 'message');
    store.delivered(callout.id);
    store.recordEvent({
      ...callout,
      id: 'failure',
      state: 'invalidated',
      marketTime: candle.end,
      recordedAt: candle.end,
    });
    const learning = new Learning(store);
    learning.process(candle.end);
    const diagnostic = new LearningDiagnostics(store).get(sampleId(callout, 'strategy_entry'))!;
    expect(diagnostic.coverage).toBe('complete');
    expect(diagnostic.tags).toContain('immediate_invalidation');
    expect(learning.cases()[0]!.diagnostics).toEqual(diagnostic);
    expect(learning.report()).toContain('Outcome diagnostics');
    const review = store.pending(candle.end).find((r) => r.event.kind === 'learning_review');
    expect(review?.event.learningText).toContain('immediate invalidation');
    learning.process(candle.end + DAY);
    expect(store.db.prepare('SELECT body FROM learning_diagnostics').all()).toHaveLength(1);
    expect(() => store.db.exec("UPDATE learning_diagnostics SET body='{}'")).toThrow('immutable');
    expect(() => store.db.exec('DELETE FROM learning_diagnostics')).toThrow('immutable');
    const sample = JSON.parse(
      (store.db.prepare('SELECT body FROM learning_journal').get() as { body: string }).body,
    );
    expect(sample.outcome).toBe('failure');
    expect(sample.features).toEqual(callout.learning);
  } finally {
    store.close();
  }
});
it('uses daily completed candles for daily reversal diagnostics', () => {
  const store = new Store(':memory:');
  try {
    const callout = event();
    callout.candidate.entry = undefined;
    callout.tracker = {
      type: 'reversal',
      timeframe: '1d',
      phase: 'warning',
      warningId: 'idea',
      warningTime: start,
      warningClose: 100,
      close: 100,
      frozenHigh: 110,
      frozenLow: 90,
      cancellationLevel: 90,
      confirmationBars: 5,
      elapsed: 0,
    };
    const daily = { ...bar(0, 106, 89, 89), start, end: start + DAY };
    store.cache(callout.instrument, '1d', [daily]);
    const observations = new LearningObservations(store);
    observations.start(callout, 'reversal_warning', start);
    observations.terminal(callout, 'reversal_warning', {
      ...callout,
      marketTime: daily.end,
      tracker: { ...callout.tracker, phase: 'cancelled', close: 89, elapsed: 1 },
    });
    observations.process(daily.end);
    const result = new LearningDiagnostics(store).get(sampleId(callout, 'reversal_warning'))!;
    expect(result.timeframe).toBe('1d');
    expect(result.completedBars).toBe(1);
    expect(result.coverage).toBe('complete');
    expect(result.tags).toContain('immediate_invalidation');
    expect(result.referenceR).toBeUndefined();
  } finally {
    store.close();
  }
});
it('preserves diagnostic and execution cursors through pauses, duplicates, and more than 512 candles', () => {
  const store = new Store(':memory:');
  try {
    const callout = event();
    const candles = Array.from({ length: 520 }, (_, n) => bar(n, 105, 95, 100));
    store.cache(callout.instrument, '15m', candles);
    store.recordEvent(callout);
    store.recordEvent({
      ...callout,
      id: 'time-exit',
      state: 'time_exit',
      marketTime: candles.at(-1)!.end,
      recordedAt: candles.at(-1)!.end,
    });
    store.set('learning_paused', true);
    new Learning(store).process(candles.at(-1)!.end);
    expect(store.db.prepare('SELECT body FROM learning_observations').all()).toHaveLength(0);
    store.set('learning_paused', false);
    new Learning(store).process(candles.at(-1)!.end);
    const diagnostic = new LearningDiagnostics(store).get(sampleId(callout, 'strategy_entry'));
    expect(diagnostic?.completedBars).toBe(520);
    new Learning(store).process(candles.at(-1)!.end);
    expect(new LearningDiagnostics(store).get(sampleId(callout, 'strategy_entry'))).toEqual(
      diagnostic,
    );
  } finally {
    store.close();
  }
});
it('does not backfill measurements for historical samples without diagnostic state', () => {
  const store = new Store(':memory:');
  try {
    const callout = event();
    const observations = new LearningObservations(store);
    observations.start(callout, 'strategy_entry', start);
    const row = store.db.prepare('SELECT body FROM learning_observations').get() as {
      body: string;
    };
    const old = JSON.parse(row.body);
    delete old.movement;
    store.db.prepare('UPDATE learning_observations SET body=?').run(JSON.stringify(old));
    store.cache(callout.instrument, '15m', [bar(0, 135, 95, 131)]);
    observations.terminal(callout, 'strategy_entry', {
      ...callout,
      state: 'final_target',
      marketTime: start + QUARTER,
    });
    observations.process(start + QUARTER);
    expect(new LearningDiagnostics(store).get(sampleId(callout, 'strategy_entry'))).toBeUndefined();
    expect(new LearningDiagnostics(store).report()).toContain(
      'Historical samples without diagnostic records are unavailable',
    );
  } finally {
    store.close();
  }
});

it('retains revision evidence after a coherent refresh clears transient quality flags', () => {
  const store = new Store(':memory:');
  try {
    const callout = event();
    const first = bar(0, 105, 95, 100);
    store.cache(callout.instrument, '15m', [first]);
    const observations = new LearningObservations(store);
    observations.start(callout, 'strategy_entry', start);
    observations.process(first.end);
    store.cache(callout.instrument, '15m', [{ ...first, high: 106 }, bar(1, 135, 95, 131)]);
    store.set(`history_changed:${callout.instrument.id}`, false);
    observations.terminal(callout, 'strategy_entry', {
      ...callout,
      state: 'final_target',
      marketTime: first.end + QUARTER,
    });
    observations.process(first.end + QUARTER);
    const result = new LearningDiagnostics(store).get(sampleId(callout, 'strategy_entry'))!;
    expect(result.coverage).toBe('incomplete');
    expect(result.coverageReasons.join(' ')).toContain('revised');
    expect(observations.measurement(sampleId(callout, 'strategy_entry'))?.execution?.status).toBe(
      'unavailable',
    );
  } finally {
    store.close();
  }
});
it('does not expose undelivered diagnostic counts in the public recap summary', async () => {
  const { ShadowLearning } = await import('../src/shadow-learning.js');
  const store = new Store(':memory:');
  try {
    const callout = event();
    const diagnostic = finishDiagnostics(
      sampleId(callout, 'strategy_entry'),
      callout,
      'strategy_entry',
      beginMovement(callout, 'strategy_entry'),
      undefined,
      'Missing candles',
      start,
    );
    store.db
      .prepare('INSERT INTO learning_diagnostics VALUES(?,?,?)')
      .run(diagnostic.sampleId, start, JSON.stringify(diagnostic));
    new ShadowLearning(store).record({
      id: diagnostic.sampleId,
      family: 'strategy_entry',
      callout,
      terminal: callout,
      features: callout.learning!,
      outcome: 'unknown',
      resolved: start,
      observedAt: start,
    });
    expect(new LearningDiagnostics(store).report()).toContain('latest 1');
    expect(new LearningDiagnostics(store).report(true)).toContain('latest 0');
    store.enqueue(callout, 'crypto_ideas');
    store.saveReceipt(callout.id, 'channel', 'message');
    expect(new LearningDiagnostics(store).report(true)).toContain('latest 1');
  } finally {
    store.close();
  }
});
