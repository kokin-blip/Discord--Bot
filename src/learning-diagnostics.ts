import type { Bar, SignalEvent, Interval } from './domain.js';
import type { Family } from './learning.js';
import type { Store } from './sql-store.js';

export interface Movement {
  schema: 'outcome-v1';
  timeframe: Interval;
  reference?: number;
  risk?: number;
  maximumChase?: number;
  completedBars: number;
  favorable: number;
  adverse: number;
  favorableAt?: number;
  adverseAt?: number;
  favorableBar?: number;
  adverseBar?: number;
  lastClose?: number;
  lastEnd?: number;
  ambiguous: boolean;
}
export interface OutcomeDiagnostics {
  schema: 'outcome-v1';
  sampleId: string;
  family: Family;
  timeframe: Interval;
  finalizedAt: number;
  terminalReason: string;
  coverage: 'complete' | 'incomplete' | 'unavailable';
  coverageReasons: string[];
  completedBars: number;
  directionalReferencePercent?: number;
  referenceR?: number;
  favorable?: {
    percent: number;
    r?: number;
    at?: number;
    barsAfterCallout?: number;
    elapsedMs?: number;
  };
  adverse?: {
    percent: number;
    r?: number;
    at?: number;
    barsAfterCallout?: number;
    elapsedMs?: number;
  };
  ambiguousOrdering: boolean;
  tags: (
    | 'immediate_invalidation'
    | 'insufficient_follow_through'
    | 'favorable_then_reversed'
    | 'near_chase_limit'
  )[];
  interpretation: string;
}
export function beginMovement(
  callout: SignalEvent,
  family: Family,
  maximumChase?: number,
): Movement {
  const reference =
    family === 'strategy_entry'
      ? callout.candidate.entry
      : (callout.learning?.close ??
        (callout.tracker?.type === 'reversal' ? callout.tracker.warningClose : undefined));
  const risk =
    family === 'strategy_entry' && reference !== undefined
      ? Math.abs(reference - callout.candidate.level)
      : undefined;
  return {
    schema: 'outcome-v1',
    timeframe: callout.tracker?.timeframe ?? '15m',
    reference:
      reference !== undefined && Number.isFinite(reference) && reference > 0
        ? reference
        : undefined,
    risk: risk !== undefined && Number.isFinite(risk) && risk > 0 ? risk : undefined,
    maximumChase,
    completedBars: 0,
    favorable: 0,
    adverse: 0,
    ambiguous: false,
  };
}
export function observeMovement(movement: Movement, callout: SignalEvent, bar: Bar) {
  // The entire confirmation candle precedes the reference entry; never include any of it.
  if (bar.start < callout.marketTime) return;
  movement.completedBars++;
  movement.lastClose = bar.close;
  movement.lastEnd = bar.end;
  if (movement.reference === undefined) return;
  const sign = callout.direction === 'bullish' ? 1 : -1;
  const favorable = sign * ((sign === 1 ? bar.high : bar.low) - movement.reference);
  const adverse = -sign * ((sign === 1 ? bar.low : bar.high) - movement.reference);
  if (favorable > movement.favorable) {
    movement.favorable = favorable;
    movement.favorableAt = bar.end;
    movement.favorableBar = movement.completedBars;
  }
  if (adverse > movement.adverse) {
    movement.adverse = adverse;
    movement.adverseAt = bar.end;
    movement.adverseBar = movement.completedBars;
  }
  const target = callout.candidate.target;
  if (target !== undefined && movement.risk !== undefined) {
    const stopped =
      sign === 1 ? bar.low <= callout.candidate.level : bar.high >= callout.candidate.level;
    const targeted = sign === 1 ? bar.high >= target : bar.low <= target;
    movement.ambiguous ||= stopped && targeted;
  }
}
export function finishDiagnostics(
  sampleId: string,
  callout: SignalEvent,
  family: Family,
  movement: Movement,
  terminal: SignalEvent | undefined,
  incomplete: string | undefined,
  now: number,
): OutcomeDiagnostics {
  const reasons = [
    incomplete,
    !terminal ? 'Original terminal outcome unavailable' : undefined,
    movement.reference === undefined ? 'Original reference price unavailable' : undefined,
    terminal && movement.lastEnd !== terminal.marketTime
      ? 'Completed observation does not reach the exact terminal candle'
      : undefined,
    terminal?.recovery ? 'Terminal outcome arrived through recovery' : undefined,
  ].filter((r): r is string => !!r);
  const coverage =
    !movement.completedBars || movement.reference === undefined
      ? 'unavailable'
      : reasons.length
        ? 'incomplete'
        : 'complete';
  const sign = callout.direction === 'bullish' ? 1 : -1;
  const close =
    terminal?.performance?.referencePrice ??
    (terminal?.tracker?.type === 'reversal' ? terminal.tracker.close : undefined) ??
    (movement.lastEnd === terminal?.marketTime ? movement.lastClose : undefined);
  const change =
    close !== undefined && Number.isFinite(close) && movement.reference !== undefined
      ? sign * (close - movement.reference)
      : undefined;
  const referenceR =
    movement.risk !== undefined && change !== undefined ? change / movement.risk : undefined;
  const extreme = (value: number, at?: number, barsAfterCallout?: number) =>
    movement.reference === undefined
      ? undefined
      : {
          percent: (100 * value) / movement.reference,
          r: movement.risk === undefined ? undefined : value / movement.risk,
          at,
          barsAfterCallout,
          elapsedMs: at === undefined ? undefined : at - callout.marketTime,
        };
  const tags: OutcomeDiagnostics['tags'] = [];
  const invalidated =
    terminal?.state === 'invalidated' ||
    (terminal?.tracker?.type === 'reversal' && terminal.tracker.phase === 'cancelled');
  if (coverage === 'complete') {
    if (invalidated && movement.completedBars >= 1 && movement.completedBars <= 2)
      tags.push('immediate_invalidation');
    if (family === 'strategy_entry' && movement.risk !== undefined) {
      if (terminal?.state === 'time_exit' && movement.favorable / movement.risk < 0.5)
        tags.push('insufficient_follow_through');
      if (movement.favorable / movement.risk >= 1 && referenceR !== undefined && referenceR <= 0)
        tags.push('favorable_then_reversed');
    }
  }
  if (
    family === 'strategy_entry' &&
    movement.reference !== undefined &&
    movement.maximumChase !== undefined &&
    movement.maximumChase > 0 &&
    sign * (movement.reference - callout.candidate.level) >= 0.8 * movement.maximumChase
  )
    tags.push('near_chase_limit');
  const terminalReason =
    terminal?.tracker?.type === 'reversal'
      ? `reversal_${terminal.tracker.phase}`
      : terminal?.state === 'time_exit'
        ? `time_exit_${change === undefined ? 'unknown' : change > 0 ? 'positive' : change < 0 ? 'negative' : 'flat'}`
        : terminal?.state === 'entry_triggered' && family === 'strategy_setup'
          ? 'setup_qualified'
          : (terminal?.state ?? 'unavailable');
  return {
    schema: 'outcome-v1',
    sampleId,
    family,
    timeframe: movement.timeframe,
    finalizedAt: now,
    terminalReason,
    coverage,
    coverageReasons: reasons,
    completedBars: movement.completedBars,
    directionalReferencePercent:
      change === undefined || movement.reference === undefined
        ? undefined
        : (100 * change) / movement.reference,
    referenceR,
    favorable: extreme(movement.favorable, movement.favorableAt, movement.favorableBar),
    adverse: extreme(movement.adverse, movement.adverseAt, movement.adverseBar),
    ambiguousOrdering:
      movement.ambiguous || !!terminal?.performance?.ambiguous || !!terminal?.observations?.length,
    tags,
    interpretation:
      'Observed completed-candle extremes and signal reference prices; not executable prices, realized returns or proven causes.',
  };
}
export class LearningDiagnostics {
  constructor(readonly store: Store) {}
  get(id: string): OutcomeDiagnostics | undefined {
    const row = this.store.db
      .prepare('SELECT body FROM learning_diagnostics WHERE sample_id=?')
      .get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  report(deliveredOnly = false): string {
    const rows = this.store.db
      .prepare(
        `SELECT d.body FROM learning_diagnostics d ${deliveredOnly ? "WHERE EXISTS(SELECT 1 FROM learning_journal j JOIN delivery_receipts r ON r.event_id=json_extract(j.body,'$.callout.id') WHERE j.id=d.sample_id)" : ''} ORDER BY d.finalized_at DESC,d.sample_id DESC LIMIT 600`,
      )
      .all() as { body: string }[];
    const diagnostics = rows.map((r) => JSON.parse(r.body) as OutcomeDiagnostics);
    const tags: Record<string, number> = {};
    for (const diagnostic of diagnostics)
      for (const tag of diagnostic.tags) tags[tag] = (tags[tag] ?? 0) + 1;
    return `Outcome diagnostics (latest ${diagnostics.length}; outcome-v1): complete ${diagnostics.filter((d) => d.coverage === 'complete').length}; incomplete/unavailable ${diagnostics.filter((d) => d.coverage !== 'complete').length}; tags ${JSON.stringify(tags)}. Historical samples without diagnostic records are unavailable. Descriptive observations, not market causes.`;
  }
}

export function diagnosticText(diagnostic: OutcomeDiagnostics | undefined): string {
  if (!diagnostic)
    return 'Outcome diagnostics: unavailable for this historical or incomplete observation.';
  const names: Record<OutcomeDiagnostics['tags'][number], string> = {
    immediate_invalidation: 'immediate invalidation',
    insufficient_follow_through: 'insufficient follow-through',
    favorable_then_reversed: 'favorable movement then reversal',
    near_chase_limit: 'near chase limit',
  };
  const movement = (value: OutcomeDiagnostics['favorable']) =>
    value
      ? `${value.percent.toFixed(2)}%${value.r === undefined ? '' : ` (${value.r.toFixed(2)}R)`}`
      : 'unknown';
  return (
    `Outcome diagnostics: ${diagnostic.terminalReason.replaceAll('_', ' ')}; ${diagnostic.completedBars} completed ${diagnostic.timeframe} candles; coverage ${diagnostic.coverage}.\n` +
    `Observed favorable/adverse excursion: ${movement(diagnostic.favorable)} / ${movement(diagnostic.adverse)}. Tags: ${diagnostic.tags.map((tag) => names[tag]).join(', ') || 'none'}.` +
    `${diagnostic.ambiguousOrdering ? ' Intrabar ordering is unknown.' : ''}` +
    `${diagnostic.coverageReasons.length ? ` Coverage limits: ${diagnostic.coverageReasons.join('; ')}.` : ''}\n` +
    diagnostic.interpretation
  );
}
