import type { SignalEvent } from './domain.js';
import type { Store } from './sql-store.js';
import type { Family } from './learning.js';
import type { DailyOutcome } from './daily-recap.js';
import type { OutcomeSample } from './shadow-learning.js';
import type { MeasurementV2 } from './entry-research/measurements.js';
import { netR } from './entry-research/execution.js';
import { stableId, strategyVersion } from './core/strategy.js';
import { DAY } from './core/time.js';
import { currentReversal } from './reversal-config.js';
import { sampleId, realCall, timeframeOf, type Measurement } from './learning-observations.js';

const dayOf = (time: number) => new Date(time - 7 * 3_600_000).toISOString().slice(0, 10);
export function learningContext(event: SignalEvent): string {
  const f = event.learning!;
  return `benchmark:${f.benchmarkTrend};alignment:${f.benchmarkTrend === 'unknown' ? 'unknown' : f.benchmarkAgreement ? 'aligned' : 'opposed'};volume:${f.breakoutRelativeVolume === undefined ? 'unknown' : f.breakoutRelativeVolume >= (f.breakoutThreshold ?? Infinity) + 0.5 ? 'strong' : 'standard'}`;
}
export function recurringFailure(
  store: Store,
  family: Family,
  version: string,
  now: number,
): boolean {
  const rows = store.db
    .prepare(
      'SELECT body FROM learning_journal WHERE family=? AND version=? AND resolved>=? ORDER BY resolved DESC,id DESC LIMIT 600',
    )
    .all(family, version, now - 30 * DAY) as { body: string }[];
  const groups = new Map<string, OutcomeSample[]>();
  for (const row of rows) {
    const sample: OutcomeSample = JSON.parse(row.body);
    if (
      !realCall(sample.callout) ||
      !realCall(sample.terminal) ||
      !['success', 'failure'].includes(sample.outcome) ||
      sample.resolved > now ||
      sample.observedAt > now ||
      sample.callout.marketTime < now - 30 * DAY
    )
      continue;
    const key = JSON.stringify([
      sample.callout.instrument.market,
      timeframeOf(sample.callout, family),
      learningContext(sample.callout),
    ]);
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) =>
      group
        .sort((a, b) => b.callout.marketTime - a.callout.marketTime || b.id.localeCompare(a.id))
        .slice(0, 10),
    )
    .some(
      (group) =>
        group.length === 10 &&
        group.filter((s) => s.outcome === 'failure').length >= 7 &&
        new Set(group.map((s) => dayOf(s.callout.marketTime))).size >= 3,
    );
}
export type EvidenceTier = 'normal' | 'recurring_failure';
export interface EvaluationPolicy {
  version: 'prospective-v1';
  tier: EvidenceTier;
  days: number;
  decisive: number;
  calloutDays: number;
  partition: number;
  cohort: number;
  retention: number;
  winnerRetention: number;
  simulationCoverage: number;
  minimumR: number;
  bootstrapSamples: number;
  lowerQuantile: number;
  costs: { slippageBps: number; feeBps: number };
}
export const evaluationPolicy = (tier: EvidenceTier): EvaluationPolicy => ({
  version: 'prospective-v1',
  tier,
  days: tier === 'normal' ? 56 : 14,
  decisive: tier === 'normal' ? 100 : 30,
  calloutDays: tier === 'normal' ? 20 : 6,
  partition: tier === 'normal' ? 20 : 8,
  cohort: tier === 'normal' ? 20 : 10,
  retention: 0.6,
  winnerRetention: 0.8,
  simulationCoverage: 0.9,
  minimumR: 0.05,
  bootstrapSamples: 2000,
  lowerQuantile: 0.025,
  costs: { slippageBps: 10, feeBps: 5 },
});
export interface Evaluation {
  id: string;
  sourceId: string;
  family: Family;
  version: string;
  kind: 'filter' | 'model';
  startedAt: number;
  endsAt: number;
  policy: EvaluationPolicy;
  definition: Record<string, unknown>;
}
export interface Decision {
  id: string;
  evaluationId: string;
  sampleId: string;
  callout: SignalEvent;
  retain: boolean;
  score?: number;
  baseline?: number;
  assignedAt?: number;
}
export interface EvidenceRow extends Decision {
  outcome?: DailyOutcome;
  simulationR?: number;
  settled: boolean;
}
const counts = () => ({
  success: 0,
  failure: 0,
  unconfirmed: 0,
  ambiguous: 0,
  unknown: 0,
  pending: 0,
});
const decisive = (r: EvidenceRow) => r.outcome === 'success' || r.outcome === 'failure';
function drawdown(values: number[]) {
  let total = 0,
    peak = 0,
    maximum = 0;
  for (const value of values) {
    total += value;
    peak = Math.max(peak, total);
    maximum = Math.max(maximum, peak - total);
  }
  return maximum;
}
function metrics(rows: EvidenceRow[], family: Family) {
  const retained = counts(),
    blocked = counts();
  for (const row of rows) (row.retain ? retained : blocked)[row.outcome ?? 'pending']++;
  const labeled = rows.filter(decisive);
  const retainedN = retained.success + retained.failure;
  const resolved = rows.filter((r) => r.outcome !== undefined);
  const modeled = rows.filter((r) => Number.isFinite(r.simulationR));
  const baselineR = modeled.reduce((sum, r) => sum + r.simulationR!, 0);
  const filteredR = modeled.reduce((sum, r) => sum + (r.retain ? r.simulationR! : 0), 0);
  const benefit =
    family === 'strategy_entry'
      ? rows.length
        ? (filteredR - baselineR) / rows.length
        : null
      : retainedN && labeled.length
        ? retained.success / retainedN - (retained.success + blocked.success) / labeled.length
        : null;
  const scored = labeled.filter((r) => r.score !== undefined && r.baseline !== undefined);
  return {
    retained,
    blocked,
    enrolled: rows.length,
    decisive: labeled.length,
    pending: rows.filter((r) => !r.settled).length,
    calloutDays: new Set(labeled.map((r) => dayOf(r.callout.marketTime))).size,
    retention: rows.length ? rows.filter((r) => r.retain).length / rows.length : 0,
    successfulCallRetention:
      retained.success + blocked.success
        ? retained.success / (retained.success + blocked.success)
        : null,
    simulationCoverage: resolved.length
      ? modeled.filter((r) => r.outcome !== undefined).length / resolved.length
      : 0,
    baselineR,
    filteredR,
    benefit,
    baselineDrawdownR: drawdown(modeled.map((r) => r.simulationR!)),
    filteredDrawdownR: drawdown(modeled.map((r) => (r.retain ? r.simulationR! : 0))),
    missedWinnerR: modeled.reduce(
      (sum, r) => sum + (!r.retain && r.simulationR! > 0 ? r.simulationR! : 0),
      0,
    ),
    avoidedLossR: modeled.reduce(
      (sum, r) => sum + (!r.retain && r.simulationR! < 0 ? -r.simulationR! : 0),
      0,
    ),
    brier: scored.length
      ? scored.reduce((sum, r) => sum + (r.score! - Number(r.outcome === 'success')) ** 2, 0) /
        scored.length
      : null,
    baselineBrier: scored.length
      ? scored.reduce((sum, r) => sum + (r.baseline! - Number(r.outcome === 'success')) ** 2, 0) /
        scored.length
      : null,
  };
}
/** Stable day-block bootstrap. Called only at the single predeclared evaluation boundary. */
export function lowerBenefitBound(evaluation: Evaluation, rows: EvidenceRow[]): number | null {
  const blocks = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    const day = dayOf(row.callout.marketTime);
    blocks.set(day, [...(blocks.get(day) ?? []), row]);
  }
  const days = [...blocks.values()].map((block) => ({
    count: block.length,
    decisive: block.filter(decisive).length,
    successes: block.filter((r) => r.outcome === 'success').length,
    retained: block.filter((r) => r.retain && decisive(r)).length,
    retainedSuccesses: block.filter((r) => r.retain && r.outcome === 'success').length,
    delta: block.reduce(
      (sum, r) => sum + (!r.retain && Number.isFinite(r.simulationR) ? -r.simulationR! : 0),
      0,
    ),
  }));
  if (days.length < 2) return null;
  let seed = Number.parseInt(stableId(evaluation.id).slice(0, 8), 16) || 1;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const samples: number[] = [];
  for (let n = 0; n < evaluation.policy.bootstrapSamples; n++) {
    let count = 0,
      decisiveCount = 0,
      successes = 0,
      retained = 0,
      retainedSuccesses = 0,
      delta = 0;
    for (let i = 0; i < days.length; i++) {
      const block = days[Math.floor(random() * days.length)]!;
      count += block.count;
      decisiveCount += block.decisive;
      successes += block.successes;
      retained += block.retained;
      retainedSuccesses += block.retainedSuccesses;
      delta += block.delta;
    }
    samples.push(
      evaluation.family === 'strategy_entry'
        ? delta / count
        : retained && decisiveCount
          ? retainedSuccesses / retained - successes / decisiveCount
          : -1,
    );
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length * evaluation.policy.lowerQuantile)]!;
}
export function scorecard(evaluation: Evaluation, rows: EvidenceRow[], finalized = false) {
  const overall = metrics(rows, evaluation.family);
  const partitions = (key: (r: EvidenceRow) => string) =>
    [...new Set(rows.map(key))].sort().map((name) => ({
      name,
      ...metrics(
        rows.filter((r) => key(r) === name),
        evaluation.family,
      ),
    }));
  const cohorts = partitions(
    (r) => `${r.callout.instrument.market}:${timeframeOf(r.callout, evaluation.family)}`,
  );
  const directions = partitions((r) => r.callout.direction);
  const lowerBound = finalized ? lowerBenefitBound(evaluation, rows) : null;
  const p = evaluation.policy;
  const blockers: string[] = [];
  if (!finalized) blockers.push('EVALUATION_NOT_FINAL');
  if (overall.decisive < p.decisive) blockers.push('INSUFFICIENT_DECISIVE_OUTCOMES');
  if (overall.calloutDays < p.calloutDays) blockers.push('INSUFFICIENT_CALLOUT_DAYS');
  if (
    overall.retained.success + overall.retained.failure < p.partition ||
    overall.blocked.success + overall.blocked.failure < p.partition
  )
    blockers.push('INSUFFICIENT_PARTITION_EVIDENCE');
  if (overall.pending) blockers.push('PENDING_OUTCOMES');
  if (overall.retention < p.retention) blockers.push('SIGNAL_RETENTION_TOO_LOW');
  if ((overall.successfulCallRetention ?? 0) < p.winnerRetention)
    blockers.push('MISSED_TOO_MANY_SUCCESSES');
  if (evaluation.family === 'strategy_entry' && overall.simulationCoverage < p.simulationCoverage)
    blockers.push('SIMULATION_COVERAGE_TOO_LOW');
  if (
    overall.benefit === null ||
    overall.benefit < (evaluation.family === 'strategy_entry' ? p.minimumR : Number.EPSILON)
  )
    blockers.push('INSUFFICIENT_BENEFIT');
  if (finalized && (lowerBound === null || lowerBound <= 0)) blockers.push('BENEFIT_NOT_SUPPORTED');
  if (
    cohorts.some(
      (c) =>
        c.decisive < p.cohort ||
        c.benefit === null ||
        c.benefit < 0 ||
        (evaluation.family === 'strategy_entry' && c.simulationCoverage < p.simulationCoverage),
    )
  )
    blockers.push('COHORT_EVIDENCE_INSUFFICIENT_OR_NEGATIVE');
  return {
    evaluationId: evaluation.id,
    sourceId: evaluation.sourceId,
    kind: evaluation.kind,
    family: evaluation.family,
    version: evaluation.version,
    policy: p,
    startedAt: evaluation.startedAt,
    endsAt: evaluation.endsAt,
    finalized,
    ...overall,
    lowerBound,
    cohorts,
    directions,
    directionalDeterioration: directions
      .filter((d) => d.benefit !== null && d.benefit < 0)
      .map((d) => d.name),
    benefitBasis:
      evaluation.family === 'strategy_entry'
        ? 'simulated net R per original opportunity'
        : 'confirmation accuracy improvement; classification evidence only',
    blockers,
    reviewReady: blockers.length === 0 && evaluation.kind === 'filter',
    interpretation:
      'Prospective shadow evidence, not realized returns or a guarantee of future improvement.',
  };
}
export type Scorecard = ReturnType<typeof scorecard>;
export class LearningEvaluations {
  constructor(readonly store: Store) {}
  create(
    sourceId: string,
    family: Family,
    version: string,
    kind: Evaluation['kind'],
    definition: Record<string, unknown>,
    now: number,
    tier: EvidenceTier = 'normal',
  ): Evaluation {
    const policy = evaluationPolicy(tier);
    const evaluation: Evaluation = {
      id: stableId('evaluation-v1', sourceId, String(now)),
      sourceId,
      family,
      version,
      kind,
      definition:
        family === 'strategy_entry'
          ? { ...definition, executionSchema: 'execution-v2' }
          : definition,
      policy,
      startedAt: now,
      endsAt: now + policy.days * DAY,
    };
    this.store.db
      .prepare('INSERT OR IGNORE INTO learning_evaluations VALUES(?,?,?,?,?,?)')
      .run(evaluation.id, sourceId, family, version, evaluation.endsAt, JSON.stringify(evaluation));
    return evaluation;
  }
  get(id: string): Evaluation | undefined {
    const row = this.store.db
      .prepare('SELECT body FROM learning_evaluations WHERE id=?')
      .get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  assign(
    evaluationId: string,
    callout: SignalEvent,
    retain: boolean,
    score?: number,
    baseline?: number,
    assignedAt = callout.recordedAt,
  ) {
    const evaluation = this.get(evaluationId);
    if (
      !evaluation ||
      !realCall(callout) ||
      callout.marketTime <= evaluation.startedAt ||
      callout.marketTime >= evaluation.endsAt ||
      callout.recordedAt < evaluation.startedAt ||
      assignedAt >= evaluation.endsAt ||
      assignedAt < callout.recordedAt ||
      callout.strategyVersion !== evaluation.version ||
      !callout.learning ||
      callout.learning.at > callout.marketTime
    )
      return false;
    const id = sampleId(callout, evaluation.family);
    if (this.store.db.prepare('SELECT 1 FROM learning_journal WHERE id=?').get(id)) return false;
    const terminal = this.store.db
      .prepare(
        `SELECT 1 FROM events WHERE idea_id=? AND (
      json_extract(body,'$.state') IN ('invalidated','final_target','time_exit','expired') OR
      json_extract(body,'$.tracker.phase') IN ('cancelled','confirmed','expired')
      ${evaluation.family === 'strategy_setup' ? "OR json_extract(body,'$.state')='entry_triggered'" : ''}) LIMIT 1`,
      )
      .get(callout.ideaId);
    if (terminal) return false;
    const decision: Decision = {
      id: stableId(evaluation.id, id),
      evaluationId,
      sampleId: id,
      callout,
      retain,
      score,
      baseline,
      assignedAt,
    };
    return !!this.store.db
      .prepare('INSERT OR IGNORE INTO learning_decisions VALUES(?,?,?,?,?)')
      .run(decision.id, evaluation.id, id, callout.marketTime, JSON.stringify(decision)).changes;
  }
  rows(evaluation: Evaluation, deliveredOnly = false): EvidenceRow[] {
    const rows = this.store.db
      .prepare(
        `SELECT d.body,j.body AS journal,m.body AS measurement,v.body AS measurement_v2 FROM learning_decisions d
      LEFT JOIN learning_journal j ON j.id=d.sample_id LEFT JOIN learning_measurements m ON m.sample_id=d.sample_id
      LEFT JOIN learning_measurements_v2 v ON v.sample_id=d.sample_id
      WHERE d.evaluation_id=? ${deliveredOnly ? "AND EXISTS(SELECT 1 FROM delivery_receipts r WHERE r.event_id=json_extract(d.body,'$.callout.id'))" : ''}
      ORDER BY d.callout_time,d.id LIMIT 5001`,
      )
      .all(evaluation.id) as {
      body: string;
      journal?: string;
      measurement?: string;
      measurement_v2?: string;
    }[];
    return rows.map((row) => {
      const decision: Decision = JSON.parse(row.body);
      const sample: OutcomeSample | undefined = row.journal ? JSON.parse(row.journal) : undefined;
      const measurement: Measurement | undefined = row.measurement
        ? JSON.parse(row.measurement)
        : undefined;
      const outcome =
        sample?.terminal.recovery || sample?.terminal.debug ? 'unknown' : sample?.outcome;
      const v2: MeasurementV2 | undefined = row.measurement_v2
        ? JSON.parse(row.measurement_v2)
        : undefined;
      return {
        ...decision,
        outcome: outcome ?? (measurement ? 'unknown' : undefined),
        simulationR:
          evaluation.family === 'strategy_entry' &&
          evaluation.definition.executionSchema === 'execution-v2'
            ? !sample?.terminal.recovery && !sample?.terminal.debug && !v2?.incomplete
              ? netR(v2?.economics)
              : undefined
            : measurement?.execution?.status === 'closed' &&
                !measurement.incomplete &&
                !sample?.terminal.recovery &&
                !sample?.terminal.debug
              ? measurement.execution.rMultiple
              : undefined,
        settled:
          evaluation.family === 'strategy_entry' &&
          evaluation.definition.executionSchema === 'execution-v2'
            ? !!v2 && (!!sample || !!v2.incomplete)
            : !!measurement && (!!sample || !!measurement.incomplete),
      };
    });
  }
  inspect(id: string): Scorecard | undefined {
    const evaluation = this.get(id);
    if (!evaluation) return;
    const row = this.store.db
      .prepare('SELECT body FROM learning_evaluation_results WHERE id=?')
      .get(id) as { body: string } | undefined;
    const result: Scorecard = row
      ? JSON.parse(row.body)
      : scorecard(evaluation, this.rows(evaluation));
    const active =
      evaluation.family === 'reversal_warning'
        ? currentReversal(this.store).version
        : strategyVersion(this.store.strategy());
    if (active !== evaluation.version && !result.blockers.includes('SOURCE_VERSION_CHANGED')) {
      result.blockers.push('SOURCE_VERSION_CHANGED');
      result.reviewReady = false;
    }
    if (
      evaluation.family === 'strategy_entry' &&
      evaluation.definition.executionSchema !== 'execution-v2'
    ) {
      if (!result.blockers.includes('FRESH_EXECUTION_V2_COHORT_REQUIRED'))
        result.blockers.push('FRESH_EXECUTION_V2_COHORT_REQUIRED');
      result.reviewReady = false;
    }
    return result;
  }
  process(now: number, limit = 4) {
    const rows = this.store.db
      .prepare(
        `SELECT e.body FROM learning_evaluations e LEFT JOIN learning_evaluation_results r ON r.id=e.id
      LEFT JOIN learning_evaluation_work w ON w.id=e.id
      WHERE r.id IS NULL AND e.ends_at<=? ORDER BY COALESCE(w.checked_at,0),e.ends_at,e.id LIMIT ?`,
      )
      .all(now, limit) as { body: string }[];
    for (const row of rows) {
      const evaluation: Evaluation = JSON.parse(row.body);
      this.store.db
        .prepare(
          'INSERT INTO learning_evaluation_work VALUES(?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at',
        )
        .run(evaluation.id, now);
      const evidence = this.rows(evaluation);
      // Measurements settle independently of source labels; expired/missing histories cannot look successful.
      if (evidence.some((r) => !r.settled)) continue;
      const result = scorecard(evaluation, evidence, true);
      if (evidence.length > 5000) {
        result.blockers.push('EVALUATION_CAPACITY_EXCEEDED');
        result.reviewReady = false;
      }
      const active =
        evaluation.family === 'reversal_warning'
          ? currentReversal(this.store).version
          : strategyVersion(this.store.strategy());
      if (active !== evaluation.version) {
        result.blockers.push('SOURCE_VERSION_CHANGED');
        result.reviewReady = false;
      }
      this.store.db
        .prepare('INSERT OR IGNORE INTO learning_evaluation_results VALUES(?,?)')
        .run(evaluation.id, JSON.stringify(result));
    }
  }
  summary(): Scorecard[] {
    const rows = this.store.db
      .prepare('SELECT id FROM learning_evaluations ORDER BY ends_at DESC,id DESC LIMIT 20')
      .all() as { id: string }[];
    return rows.map((r) => this.inspect(r.id)!);
  }
  report(deliveredOnly = false): string {
    if (deliveredOnly) {
      return (
        this.summary()
          .map((full) => {
            const evaluation = this.get(full.evaluationId)!;
            const subset = metrics(this.rows(evaluation, true), evaluation.family);
            return (
              `${full.sourceId} · ${full.policy.tier} · ${full.finalized ? 'evaluation finalized' : 'collecting shadow evidence'}: ` +
              `${subset.enrolled} delivered-call assignments; avoided failures ${subset.blocked.failure}; missed successes ${subset.blocked.success}; ` +
              `retained ${subset.retained.success + subset.retained.failure} decisive calls. ` +
              (evaluation.family === 'strategy_entry'
                ? `Delivered-call simulated baseline/filtered R ${subset.baselineR.toFixed(3)}/${subset.filteredR.toFixed(3)}; coverage ${(100 * subset.simulationCoverage).toFixed(1)}%. `
                : '') +
              'Delivered subset is descriptive only; the full frozen evaluation controls manager review. No confidence test is repeated on this subset.'
            );
          })
          .join('\n') || 'Prospective improvement scorecards: awaiting fresh evaluations.'
      );
    }
    return (
      this.summary()
        .map(
          (s) =>
            `${s.sourceId} · ${s.family} · ${s.policy.tier} · ${s.finalized ? 'final' : 'collecting'}\n` +
            `${s.enrolled} enrolled; ${s.decisive} decisive; ${s.pending} pending. Avoided failures ${s.blocked.failure}; missed successes ${s.blocked.success}; signal retention ${(s.retention * 100).toFixed(1)}%; success retention ${s.successfulCallRetention === null ? 'unknown' : (s.successfulCallRetention * 100).toFixed(1) + '%'}.\n` +
            `Benefit ${s.benefit ?? 'unknown'} (${s.benefitBasis}); lower bound ${s.lowerBound ?? 'not tested before finalization'}. Baseline/filtered R ${s.baselineR.toFixed(3)}/${s.filteredR.toFixed(3)}; missed winner R ${s.missedWinnerR.toFixed(3)}; simulation coverage ${(s.simulationCoverage * 100).toFixed(1)}%.\n` +
            `Review ready: ${s.reviewReady}; blockers: ${s.blockers.join(', ') || 'none'}.\nCohorts/directions: ${JSON.stringify({ cohorts: s.cohorts, directions: s.directions, brier: s.brier, baselineBrier: s.baselineBrier })}`,
        )
        .join('\n\n') || 'Prospective improvement scorecards: awaiting fresh evaluations.'
    );
  }
}
