import { expect, it } from 'vitest';
import { Store } from '../src/storage.js';
import { defaults } from '../src/config.js';
import { advance, strategyVersion } from '../src/core/strategy.js';
import { fixture, idea } from './fixtures.js';
import { DAY, QUARTER } from '../src/core/time.js';
import {
  LearningEvaluations,
  evaluationPolicy,
  scorecard,
  recurringFailure,
  type Evaluation,
  type EvidenceRow,
} from '../src/learning-evaluation.js';
import { LearningObservations, sampleId } from '../src/learning-observations.js';
import { ShadowLearning } from '../src/shadow-learning.js';
import { Learning } from '../src/learning.js';
import type { SignalEvent } from '../src/domain.js';

const start = Date.parse('2026-01-01T12:00:00Z');
const entryTemplates = new Map<'bullish' | 'bearish', SignalEvent>();
function event(id: string, at = start, direction: 'bullish' | 'bearish' = 'bullish'): SignalEvent {
  let template = entryTemplates.get(direction);
  if (!template) {
    const data = fixture(direction);
    template = advance(idea(data), data, defaults, data.provenance.asOf).events.at(-1)!;
    entryTemplates.set(direction, template);
  }
  const event = structuredClone(template);
  Object.assign(event, {
    id,
    ideaId: id,
    marketTime: at,
    recordedAt: at,
    recovery: false,
    direction,
  });
  event.provenance = { provider: 'Alpaca', feed: 'SIP unit test data', delayMinutes: 0, asOf: at };
  Object.assign(event.candidate, {
    id,
    entry: 100,
    level: direction === 'bullish' ? 90 : 110,
    target: direction === 'bullish' ? 130 : 70,
    atr: 10,
    confirmedAt: at,
  });
  event.learning = {
    at,
    close: 100,
    benchmarkTrend: 'up',
    benchmarkAgreement: true,
    breakoutRelativeVolume: 1.5,
    breakoutThreshold: 1.5,
  };
  return event;
}
function evaluation(tier: 'normal' | 'recurring_failure' = 'normal'): Evaluation {
  return {
    id: 'candidate',
    sourceId: 'filter',
    family: 'strategy_entry',
    kind: 'filter',
    version: strategyVersion(defaults),
    policy: evaluationPolicy(tier),
    startedAt: start,
    endsAt: start + evaluationPolicy(tier).days * DAY,
    definition: { filter: 'volume025' },
  };
}
it('keeps legacy entry evidence readable but requires a new homogeneous execution-v2 cohort', () => {
  const store = new Store(':memory:');
  try {
    const legacy = evaluation();
    store.db
      .prepare('INSERT INTO learning_evaluations VALUES(?,?,?,?,?,?)')
      .run(
        legacy.id,
        legacy.sourceId,
        legacy.family,
        legacy.version,
        legacy.endsAt,
        JSON.stringify(legacy),
      );
    const result = new LearningEvaluations(store).inspect(legacy.id)!;
    expect(result.blockers).toContain('FRESH_EXECUTION_V2_COHORT_REQUIRED');
    expect(result.reviewReady).toBe(false);
  } finally {
    store.close();
  }
});
function evidence(count = 100): EvidenceRow[] {
  return Array.from({ length: count }, (_, n) => ({
    id: String(n),
    evaluationId: 'candidate',
    sampleId: String(n),
    callout: event(String(n), start + (1 + Math.floor(n / 4)) * DAY),
    retain: n % 5 !== 0,
    outcome: n % 5 ? ('success' as const) : ('failure' as const),
    simulationR: n % 5 ? 2 : -1,
    settled: true,
  }));
}
function persist(store: Store, candidate: Evaluation, rows: EvidenceRow[]) {
  const evaluations = new LearningEvaluations(store);
  for (const row of rows) {
    evaluations.assign(candidate.id, row.callout, row.retain, row.score, row.baseline);
    const id = sampleId(row.callout, candidate.family);
    new ShadowLearning(store).record({
      id,
      family: candidate.family,
      callout: row.callout,
      terminal: {
        ...row.callout,
        id: `end-${row.id}`,
        state: row.outcome === 'failure' ? 'invalidated' : 'final_target',
      },
      features: row.callout.learning!,
      outcome: row.outcome!,
      resolved: row.callout.marketTime + QUARTER,
      observedAt: row.callout.marketTime + QUARTER,
    });
    if (row.settled)
      store.db.prepare('INSERT INTO learning_measurements VALUES(?,?)').run(
        id,
        JSON.stringify({
          schema: 'execution-v1',
          sampleId: id,
          finalizedAt: row.callout.marketTime + QUARTER,
          windowEnd: row.callout.marketTime + QUARTER,
          execution:
            row.simulationR === undefined
              ? { status: 'unavailable', reason: 'Missing candles' }
              : { status: 'closed', rMultiple: row.simulationR },
        }),
      );
    if (row.settled && candidate.definition.executionSchema === 'execution-v2')
      store.db.prepare('INSERT INTO learning_measurements_v2 VALUES(?,?)').run(
        id,
        JSON.stringify({
          schema: 'execution-v2',
          sampleId: id,
          finalizedAt: row.callout.marketTime + QUARTER,
          economics: {
            schema: 'execution-v2',
            cases: [
              {
                name: 'normal:cost1',
                execution:
                  row.simulationR === undefined
                    ? { status: 'unavailable', reason: 'Missing candles' }
                    : { status: 'closed', rMultiple: row.simulationR },
              },
            ],
          },
        }),
      );
  }
}
it('supports both frozen policies and requires fresh evidence rather than old counts', () => {
  expect(evaluationPolicy('normal')).toMatchObject({
    days: 56,
    decisive: 100,
    calloutDays: 20,
    partition: 20,
    cohort: 20,
  });
  expect(evaluationPolicy('recurring_failure')).toMatchObject({
    days: 14,
    decisive: 30,
    calloutDays: 6,
    partition: 8,
    cohort: 10,
  });
  expect(scorecard(evaluation(), evidence()).blockers).toContain('EVALUATION_NOT_FINAL');
  const result = scorecard(evaluation(), evidence(), true);
  expect(result.reviewReady).toBe(true);
  expect(result.benefit).toBeCloseTo(0.2);
  expect(result.lowerBound).toBeGreaterThan(0);
  expect(scorecard(evaluation(), evidence(), true).lowerBound).toBe(result.lowerBound);
  const urgent = evidence(30).map((r, n) => ({
    ...r,
    retain: n % 4 !== 0,
    outcome: n % 4 !== 0 ? ('success' as const) : ('failure' as const),
    simulationR: n % 4 !== 0 ? 2 : -1,
  }));
  expect(scorecard(evaluation('recurring_failure'), urgent, true).reviewReady).toBe(true);
});
it('rejects a filter that avoids more losses but discards larger winners', () => {
  const rows = evidence().map((r, n) => ({
    ...r,
    retain: n >= 14,
    outcome: n < 10 ? ('failure' as const) : ('success' as const),
    simulationR: n < 10 ? -1 : n < 14 ? 3 : 1,
  }));
  const result = scorecard(evaluation(), rows, true);
  expect(result.avoidedLossR).toBe(10);
  expect(result.missedWinnerR).toBe(12);
  expect(result.benefit).toBeCloseTo(-0.02);
  expect(result.blockers).toContain('INSUFFICIENT_BENEFIT');
  expect(result.reviewReady).toBe(false);
});
it('keeps economics independent of binary labels and blocks missing simulations, poor coverage and sparse cohorts', () => {
  const missing = evidence().map((r, n) => ({
    ...r,
    simulationR: n < 11 ? undefined : r.simulationR,
  }));
  expect(scorecard(evaluation(), missing, true).blockers).toContain('SIMULATION_COVERAGE_TOO_LOW');
  const sparse = evidence();
  for (const r of sparse.slice(0, 10))
    r.callout.instrument = { ...r.callout.instrument, market: 'equity' };
  expect(scorecard(evaluation(), sparse, true).blockers).toContain(
    'COHORT_EVIDENCE_INSUFFICIENT_OR_NEGATIVE',
  );
  const bad = evidence().map((r) => ({ ...r, simulationR: 2 }));
  expect(scorecard(evaluation(), bad, true).benefit).toBeLessThan(0);
  const narrow = evidence().map((r, n) => ({ ...r, retain: n < 50 }));
  expect(scorecard(evaluation(), narrow, true).blockers).toContain('SIGNAL_RETENTION_TOO_LOW');
});
it('reports directional deterioration and Brier loss against the frozen baseline', () => {
  const rows = evidence().map((r, n) => ({
    ...r,
    callout: { ...r.callout, direction: n < 20 ? ('bearish' as const) : ('bullish' as const) },
    simulationR: n < 20 ? 1 : r.simulationR,
    score: r.outcome === 'success' ? 0.9 : 0.1,
    baseline: 0.5,
  }));
  const result = scorecard(evaluation(), rows, true);
  expect(result.directionalDeterioration).toEqual(['bearish']);
  expect(result.brier).toBeCloseTo(0.01);
  expect(result.baselineBrier).toBe(0.25);
});
it('finalizes only once after enrollment and outcomes settle; decisions and results are immutable', () => {
  const store = new Store(':memory:');
  try {
    const evaluations = new LearningEvaluations(store);
    const candidate = evaluations.create(
      'filter',
      'strategy_entry',
      strategyVersion(defaults),
      'filter',
      { filter: 'volume025' },
      start,
    );
    persist(store, candidate, evidence());
    expect(evaluations.assign(candidate.id, event('too-early', start), true)).toBe(false);
    expect(evaluations.assign(candidate.id, event('too-late', candidate.endsAt), true)).toBe(false);
    const synthetic = event('synthetic', start + DAY);
    synthetic.debug = true;
    expect(evaluations.assign(candidate.id, synthetic, true)).toBe(false);
    const replay = event('replay', start + DAY);
    replay.recovery = true;
    expect(evaluations.assign(candidate.id, replay, true)).toBe(false);
    expect(evaluations.assign(candidate.id, evidence()[0]!.callout, true)).toBe(false);
    evaluations.process(candidate.endsAt - 1);
    expect(evaluations.inspect(candidate.id)?.finalized).toBe(false);
    evaluations.process(candidate.endsAt);
    const result = evaluations.inspect(candidate.id)!;
    expect(result.reviewReady).toBe(true);
    evaluations.process(candidate.endsAt + DAY);
    expect(evaluations.inspect(candidate.id)).toEqual(result);
    for (const table of [
      'learning_evaluations',
      'learning_decisions',
      'learning_evaluation_results',
      'learning_measurements',
    ]) {
      expect(() => store.db.exec(`UPDATE ${table} SET body='{}'`)).toThrow('immutable');
      expect(() => store.db.exec(`DELETE FROM ${table}`)).toThrow('immutable');
    }
    store.saveStrategy({ ...defaults, breakoutVolume: 2 });
    expect(evaluations.inspect(candidate.id)?.blockers).toContain('SOURCE_VERSION_CHANGED');
    expect(evaluations.inspect(candidate.id)?.reviewReady).toBe(false);
  } finally {
    store.close();
  }
});
it('does not finalize pending outcomes or accept aggregate-only legacy evidence', () => {
  const store = new Store(':memory:');
  try {
    const evaluations = new LearningEvaluations(store);
    const candidate = evaluations.create(
      'pending',
      'strategy_entry',
      strategyVersion(defaults),
      'filter',
      {},
      start,
    );
    persist(
      store,
      candidate,
      evidence().map((r, n) => ({ ...r, settled: n !== 0 })),
    );
    evaluations.process(candidate.endsAt);
    expect(evaluations.inspect(candidate.id)?.finalized).toBe(false);
    const legacy = {
      id: 'legacy',
      family: 'strategy_entry' as const,
      filter: 'volume025' as const,
      version: strategyVersion(defaults),
      proposedAt: start,
      status: 'shadow' as const,
      pass: { failure: 0, success: 100, unconfirmed: 0, ambiguous: 0, unknown: 0 },
      blocked: { failure: 100, success: 0, unconfirmed: 0, ambiguous: 0, unknown: 0 },
      evidence: { eligible: 200, failures: 100, difference: 1 },
    };
    store.db
      .prepare('INSERT INTO learning_experiments VALUES(?,?)')
      .run(legacy.id, JSON.stringify(legacy));
    expect(new Learning(store).ready(legacy, start + 100 * DAY)).toBe(false);
    expect(() => new Learning(store).promote(legacy.id, start + 100 * DAY)).toThrow(
      'FRESH_EVALUATION_REQUIRED',
    );
    new Learning(store).process(start + 100 * DAY);
    const migrated = new Learning(store).experiments()[0]!;
    expect(evaluations.get(migrated.evaluationId!)?.startedAt).toBe(start + 100 * DAY);
    expect(evaluations.inspect(migrated.evaluationId!)?.enrolled).toBe(0);
  } finally {
    store.close();
  }
});
it('requires seven of the latest ten same-context failures across three days, excluding synthetic and future-known labels', () => {
  const store = new Store(':memory:');
  try {
    const shadow = new ShadowLearning(store);
    for (let n = 0; n < 10; n++) {
      const callout = event(`repeat-${n}`, start + Math.floor(n / 3) * DAY);
      shadow.record({
        id: sampleId(callout, 'strategy_entry'),
        family: 'strategy_entry',
        callout,
        terminal: { ...callout, id: `end-${n}` },
        features: callout.learning!,
        outcome: n < 7 ? 'failure' : 'success',
        resolved: callout.marketTime + QUARTER,
        observedAt: callout.marketTime + QUARTER,
      });
    }
    expect(
      recurringFailure(store, 'strategy_entry', strategyVersion(defaults), start + 5 * DAY),
    ).toBe(true);
    expect(
      recurringFailure(store, 'strategy_entry', strategyVersion(defaults), start + 40 * DAY),
    ).toBe(false);
    expect(
      recurringFailure(store, 'reversal_warning', strategyVersion(defaults), start + 5 * DAY),
    ).toBe(false);
    expect(recurringFailure(store, 'strategy_entry', 'other', start + 5 * DAY)).toBe(false);
  } finally {
    store.close();
  }
});
it.each(['bullish', 'bearish'] as const)(
  'observes %s simulated execution incrementally through restart without provider access',
  (direction) => {
    const store = new Store(':memory:');
    try {
      const callout = event('stream', start, direction);
      const first = {
        start,
        end: start + QUARTER,
        open: 100,
        close: 100,
        low: 95,
        high: 105,
        volume: 1,
      };
      store.cache(callout.instrument, '15m', [first]);
      new LearningObservations(store).start(callout, 'strategy_entry', start);
      new LearningObservations(store).process(first.end);
      expect(
        new LearningObservations(store).measurement(sampleId(callout, 'strategy_entry')),
      ).toBeUndefined();
      const second = {
        ...first,
        start: first.end,
        end: first.end + QUARTER,
        high: direction === 'bullish' ? 135 : 101,
        low: direction === 'bullish' ? 99 : 65,
      };
      store.cache(callout.instrument, '15m', [second]);
      const terminal = {
        ...callout,
        id: 'stream-end',
        state: 'final_target' as const,
        marketTime: second.end,
      };
      new LearningObservations(store).terminal(callout, 'strategy_entry', terminal);
      new LearningObservations(store).process(second.end);
      const result = new LearningObservations(store).measurement(
        sampleId(callout, 'strategy_entry'),
      )!;
      expect(result.execution?.status).toBe('closed');
      expect(result.execution?.rMultiple).toBeGreaterThan(2);
      expect(result.execution?.entryAt).toBe(start);
      new LearningObservations(store).process(second.end + DAY);
      expect(store.db.prepare('SELECT body FROM learning_measurements').all()).toHaveLength(1);
    } finally {
      store.close();
    }
  },
);
it('waits for next-bar time exits and marks missing scheduled bars unavailable', () => {
  const store = new Store(':memory:');
  try {
    const callout = event('time-exit');
    const bar = {
      start,
      end: start + QUARTER,
      open: 100,
      close: 101,
      low: 99,
      high: 102,
      volume: 1,
    };
    const observations = new LearningObservations(store);
    observations.start(callout, 'strategy_entry', start);
    observations.terminal(callout, 'strategy_entry', {
      ...callout,
      state: 'time_exit',
      marketTime: bar.end,
    });
    store.cache(callout.instrument, '15m', [bar]);
    observations.process(bar.end);
    expect(observations.measurement(sampleId(callout, 'strategy_entry'))).toBeUndefined();
    store.cache(callout.instrument, '15m', [
      { ...bar, start: bar.end, end: bar.end + QUARTER, open: 101 },
    ]);
    observations.process(bar.end + QUARTER);
    expect(observations.measurement(sampleId(callout, 'strategy_entry'))?.execution?.reason).toBe(
      'Time exit at next-bar open',
    );
    const missing = event('missing', start + DAY);
    observations.start(missing, 'strategy_entry', missing.marketTime);
    observations.terminal(missing, 'strategy_entry', {
      ...missing,
      state: 'invalidated',
      marketTime: missing.marketTime + QUARTER,
    });
    observations.process(missing.marketTime + QUARTER);
    expect(observations.measurement(sampleId(missing, 'strategy_entry'))?.execution?.status).toBe(
      'unavailable',
    );
    expect(observations.measurement(sampleId(missing, 'strategy_entry'))?.incomplete).toContain(
      'Missing',
    );
  } finally {
    store.close();
  }
});

it('keeps recurring failures isolated by context and observed time', () => {
  const store = new Store(':memory:');
  try {
    const shadow = new ShadowLearning(store);
    for (let n = 0; n < 10; n++) {
      const callout = event(`mixed-${n}`, start + Math.floor(n / 3) * DAY);
      callout.learning!.benchmarkAgreement = n < 5;
      shadow.record({
        id: sampleId(callout, 'strategy_entry'),
        family: 'strategy_entry',
        callout,
        terminal: callout,
        features: callout.learning!,
        outcome: 'failure',
        resolved: callout.marketTime + QUARTER,
        observedAt: callout.marketTime + QUARTER,
      });
    }
    expect(
      recurringFailure(store, 'strategy_entry', strategyVersion(defaults), start + 5 * DAY),
    ).toBe(false);
    for (let n = 0; n < 5; n++) {
      const callout = event(`future-known-${n}`, start + n * DAY);
      shadow.record({
        id: sampleId(callout, 'strategy_entry'),
        family: 'strategy_entry',
        callout,
        terminal: callout,
        features: callout.learning!,
        outcome: 'failure',
        resolved: callout.marketTime + QUARTER,
        observedAt: start + 10 * DAY,
      });
    }
    expect(
      recurringFailure(store, 'strategy_entry', strategyVersion(defaults), start + 5 * DAY),
    ).toBe(false);
  } finally {
    store.close();
  }
});
it('does not let pending evaluations starve later completed evaluations', () => {
  const store = new Store(':memory:');
  try {
    const evaluations = new LearningEvaluations(store);
    const older = evaluations.create(
      'older',
      'strategy_entry',
      strategyVersion(defaults),
      'filter',
      {},
      start,
    );
    persist(
      store,
      older,
      evidence()
        .slice(0, 1)
        .map((r) => ({ ...r, settled: false })),
    );
    const later = evaluations.create(
      'later',
      'strategy_entry',
      strategyVersion(defaults),
      'filter',
      {},
      start + DAY,
    );
    evaluations.process(later.endsAt, 1);
    evaluations.process(later.endsAt + 1, 1);
    expect(evaluations.inspect(older.id)?.finalized).toBe(false);
    expect(evaluations.inspect(later.id)?.finalized).toBe(true);
  } finally {
    store.close();
  }
});
it('shares execution conventions for gap stops and same-candle ambiguity in both directions', async () => {
  const { beginExecution, stepExecution } = await import('../src/research/execution.js');
  for (const direction of ['bullish', 'bearish'] as const) {
    const callout = event(direction, start, direction);
    const first = {
      start,
      end: start + QUARTER,
      open: 100,
      close: 100,
      high: 101,
      low: 99,
      volume: 1,
    };
    const opened = beginExecution(
      first,
      direction,
      callout.candidate.level,
      callout.candidate.target,
    );
    const both = { ...first, start: first.end, end: first.end + QUARTER, high: 140, low: 60 };
    const stopped = stepExecution(
      opened,
      both,
      direction,
      callout.candidate.level,
      callout.candidate.target!,
    );
    expect(stopped.status).toBe('closed');
    expect(stopped.ambiguous).toBe(true);
    expect(stopped.rMultiple).toBeLessThan(-1);
    const gap = { ...both, open: direction === 'bullish' ? 85 : 115 };
    expect(
      stepExecution(opened, gap, direction, callout.candidate.level, callout.candidate.target!)
        .reason,
    ).toBe('Gap through stop');
    expect(
      beginExecution(gap, direction, callout.candidate.level, callout.candidate.target).status,
    ).toBe('skipped');
  }
});
it('enforces successful entry promotion against immutable evidence and preserves rollback', () => {
  const store = new Store(':memory:');
  try {
    const evaluations = new LearningEvaluations(store);
    const candidate = evaluations.create(
      'approved-filter',
      'strategy_entry',
      strategyVersion(defaults),
      'filter',
      { filter: 'volume025' },
      start,
    );
    persist(store, candidate, evidence());
    evaluations.process(candidate.endsAt);
    const zero = { failure: 0, success: 0, unconfirmed: 0, ambiguous: 0, unknown: 0 };
    const experiment = {
      id: candidate.sourceId,
      family: candidate.family,
      filter: 'volume025',
      version: candidate.version,
      proposedAt: start,
      status: 'shadow',
      pass: zero,
      blocked: zero,
      evidence: { eligible: 20, failures: 5, difference: 0.2 },
      evaluationId: candidate.id,
    };
    store.db
      .prepare('INSERT INTO learning_experiments VALUES(?,?)')
      .run(experiment.id, JSON.stringify(experiment));
    const learning = new Learning(store);
    const next = learning.promote(experiment.id, candidate.endsAt);
    expect(store.strategy().breakoutVolume).toBe(defaults.breakoutVolume + 0.25);
    expect(store.get('historical_replay_verified', true)).toBe(false);
    expect(store.get('soak_start', 1)).toBe(0);
    expect(learning.rollback(experiment.id)).toBe(candidate.version);
    expect(store.strategy()).toEqual(defaults);
    expect(next).not.toBe(candidate.version);
  } finally {
    store.close();
  }
});

it('rejects retroactive enrollment after a terminal event is already known and isolates public delivered counts', () => {
  const store = new Store(':memory:');
  try {
    const evaluations = new LearningEvaluations(store);
    const candidate = evaluations.create(
      'public-and-private',
      'strategy_entry',
      strategyVersion(defaults),
      'filter',
      { filter: 'volume025' },
      start,
    );
    const late = event('already-resolved', start + DAY);
    store.recordEvent(late);
    store.recordEvent({
      ...late,
      id: 'already-resolved-end',
      state: 'invalidated',
      marketTime: late.marketTime + QUARTER,
      recordedAt: late.marketTime + QUARTER,
    });
    expect(
      evaluations.assign(
        candidate.id,
        late,
        false,
        undefined,
        undefined,
        late.marketTime + QUARTER,
      ),
    ).toBe(false);
    const synthetic = event('synthetic-source', start + DAY);
    synthetic.provenance.feed = 'SYNTHETIC invented prices';
    expect(evaluations.assign(candidate.id, synthetic, true)).toBe(false);
    const rows = evidence();
    persist(store, candidate, rows);
    const delivered = rows[0]!.callout;
    store.enqueue(delivered, 'crypto_ideas');
    store.saveReceipt(delivered.id, 'channel', 'message');
    expect(evaluations.report(true)).toContain('1 delivered-call assignments');
    expect(evaluations.report()).toContain('100 enrolled');
    expect(evaluations.report(true)).not.toContain('100 enrolled');
    expect(evaluations.report(true)).toContain('No confidence test is repeated');
  } finally {
    store.close();
  }
});
