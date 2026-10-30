import type { Session, SignalEvent } from './domain.js';
import type { Family } from './learning.js';
import type { Store } from './sql-store.js';
import { EntryMeasurements } from './entry-research/measurements.js';
import { DAY, QUARTER, dayStart, expectedIntraday, validateBars } from './core/time.js';
import { stableId } from './core/strategy.js';
import { beginExecution, stepExecution, type Execution } from './research/execution.js';
import {
  beginMovement,
  observeMovement,
  finishDiagnostics,
  type Movement,
} from './learning-diagnostics.js';

export const sampleId = (event: SignalEvent, family: Family) =>
  stableId('learning-sample', event.id, family);
export const timeframeOf = (event: SignalEvent, family: Family) =>
  event.tracker?.timeframe ?? (family === 'strategy_setup' ? '1d' : '15m');
export const realCall = (event: SignalEvent) =>
  !event.debug &&
  !event.recovery &&
  !/synthetic|fixture|debug/i.test(`${event.provenance.provider} ${event.provenance.feed}`);
export interface Observation {
  sampleId: string;
  callout: SignalEvent;
  family: Family;
  window: { origin: number; sessions?: number; bars?: number; timeframe: '1d' | '15m' };
  lastBar: number;
  execution?: Execution;
  terminal?: SignalEvent;
  incomplete?: string;
  movement?: Movement;
  historyRevision?: number;
}
export interface Measurement {
  schema: 'execution-v1';
  sampleId: string;
  finalizedAt: number;
  windowEnd: number;
  execution?: Execution;
  incomplete?: string;
}
export function windowEnd(
  observation: Observation,
  sessions: Session[],
  cutoff: number,
): number | undefined {
  const { window, callout } = observation;
  if (window.sessions !== undefined) {
    if (callout.instrument.market === 'crypto')
      return dayStart(window.origin) + window.sessions * DAY;
    return sessions.filter((s) => s.open >= window.origin)[window.sessions - 1]?.close;
  }
  if (window.timeframe === '15m')
    return (
      expectedIntraday(window.origin, cutoff, callout.instrument.market, sessions)[
        window.bars! - 1
      ]! + QUARTER || undefined
    );
  if (callout.instrument.market === 'crypto') return window.origin + window.bars! * DAY;
  return sessions.filter((s) => s.close > window.origin)[window.bars! - 1]?.close;
}
export class LearningObservations {
  constructor(readonly store: Store) {}
  start(callout: SignalEvent, family: Family, now: number) {
    if (!realCall(callout)) return;
    const id = sampleId(callout, family);
    if (this.measurement(id)) return;
    if (family === 'strategy_entry') new EntryMeasurements(this.store).start(id, callout);
    const config =
      family === 'reversal_warning' ? undefined : this.store.version(callout.strategyVersion);
    const observation: Observation = {
      sampleId: id,
      callout,
      family,
      lastBar: callout.marketTime,
      historyRevision: this.store.get(`learning_history_revision:${callout.instrument.id}`, 0),
      movement: beginMovement(
        callout,
        family,
        family === 'strategy_entry' ? config!.maxChase * callout.candidate.atr : undefined,
      ),
      window:
        family === 'reversal_warning'
          ? {
              origin: callout.marketTime,
              bars: callout.tracker?.type === 'reversal' ? callout.tracker.confirmationBars : 5,
              timeframe: callout.tracker?.timeframe ?? '15m',
            }
          : {
              origin:
                family === 'strategy_entry'
                  ? callout.marketTime
                  : (callout.candidate.retest?.end ?? callout.candidate.breakout.end),
              sessions:
                family === 'strategy_entry'
                  ? config!.exitSessions
                  : callout.candidate.retest
                    ? config!.confirmationSessions
                    : config!.retestBars,
              timeframe: '15m',
            },
    };
    this.store.db
      .prepare('INSERT OR IGNORE INTO learning_observations VALUES(?,?,?)')
      .run(id, now, JSON.stringify(observation));
  }
  terminal(callout: SignalEvent, family: Family, terminal: SignalEvent) {
    const id = sampleId(callout, family);
    const row = this.store.db
      .prepare('SELECT body FROM learning_observations WHERE sample_id=?')
      .get(id) as { body: string } | undefined;
    if (!row) return;
    const observation: Observation = JSON.parse(row.body);
    observation.terminal ??= terminal;
    this.store.db
      .prepare('UPDATE learning_observations SET body=? WHERE sample_id=?')
      .run(JSON.stringify(observation), id);
  }
  progress(event: SignalEvent, family: Family) {
    if (family !== 'strategy_setup' || event.state !== 'setup_ready' || !event.candidate.retest)
      return;
    const pending = this.store.db
      .prepare('SELECT body FROM learning_pending WHERE id=?')
      .get(`${event.ideaId}:${family}`) as { body: string } | undefined;
    if (!pending) return;
    const callout: SignalEvent = JSON.parse(pending.body).event;
    const id = sampleId(callout, family);
    const row = this.store.db
      .prepare('SELECT body FROM learning_observations WHERE sample_id=?')
      .get(id) as { body: string } | undefined;
    if (!row) return;
    const observation: Observation = JSON.parse(row.body);
    observation.window.origin = event.candidate.retest.end;
    observation.window.sessions = this.store.version(callout.strategyVersion).confirmationSessions;
    this.store.db
      .prepare('UPDATE learning_observations SET body=? WHERE sample_id=?')
      .run(JSON.stringify(observation), id);
  }
  measurement(id: string): Measurement | undefined {
    const row = this.store.db
      .prepare('SELECT body FROM learning_measurements WHERE sample_id=?')
      .get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  process(now: number, limit = 20, sample?: string) {
    const sessions = this.store.get<{ rows: Session[] }>('calendar', { rows: [] }).rows;
    const rows = (
      sample
        ? this.store.db
            .prepare('SELECT body FROM learning_observations WHERE sample_id=?')
            .all(sample)
        : this.store.db
            .prepare('SELECT body FROM learning_observations ORDER BY updated_at,sample_id LIMIT ?')
            .all(limit)
    ) as { body: string }[];
    for (const row of rows)
      this.store.transaction(() => {
        const observation: Observation = JSON.parse(row.body);
        const { callout, family } = observation;
        const cutoff = now - callout.provenance.delayMinutes * 60_000;
        const horizon = windowEnd(observation, sessions, cutoff);
        const terminalAt = observation.terminal?.marketTime;
        // A time exit executes on the following scheduled bar; other terminal windows need no extra bar.
        const timeExit = observation.terminal?.state === 'time_exit' ? terminalAt : horizon;
        const daily = callout.tracker?.timeframe === '1d';
        const bars = this.store
          .bars(callout.instrument, daily ? '1d' : '15m')
          .filter((b) => b.end <= cutoff && b.end > observation.lastBar);
        try {
          validateBars(bars);
        } catch {
          observation.incomplete = 'Invalid cached candles';
        }
        if (this.store.get(`history_changed:${callout.instrument.id}`, false))
          observation.incomplete = 'Historical candles revised';
        if (
          (observation.historyRevision ?? 0) !==
          this.store.get(`learning_history_revision:${callout.instrument.id}`, 0)
        )
          observation.incomplete = 'Historical candles revised during the observation window';
        if (
          callout.instrument.market === 'equity' &&
          (!sessions.length ||
            sessions[0]!.open > callout.marketTime ||
            sessions.at(-1)!.close < Math.min(cutoff, terminalAt ?? cutoff))
        )
          observation.incomplete = 'Calendar coverage unavailable';
        const expected = daily
          ? callout.instrument.market === 'crypto'
            ? Array.from(
                { length: Math.max(0, Math.floor((cutoff - observation.lastBar) / DAY)) },
                (_, n) => observation.lastBar + n * DAY,
              )
            : sessions
                .filter((s) => s.close > observation.lastBar && s.close <= cutoff)
                .map((s) => Date.parse(`${s.date}T00:00:00Z`))
          : expectedIntraday(observation.lastBar, cutoff, callout.instrument.market, sessions);
        const byStart = new Map(bars.map((b) => [b.start, b]));
        for (const start of expected.slice(0, 512)) {
          const bar = byStart.get(start);
          if (!bar) {
            observation.incomplete = 'Missing expected completed candle';
            break;
          }
          if (!daily && bar.end - bar.start !== QUARTER) {
            observation.incomplete = 'Invalid candle duration';
            break;
          }
          if (family === 'strategy_entry' && !observation.incomplete) {
            observation.execution ??= beginExecution(
              bar,
              callout.direction,
              callout.candidate.level,
              callout.candidate.target,
            );
            observation.execution = stepExecution(
              observation.execution,
              bar,
              callout.direction,
              callout.candidate.level,
              callout.candidate.target!,
              timeExit,
            );
          }
          if (
            observation.movement &&
            !observation.incomplete &&
            (terminalAt === undefined || bar.end <= terminalAt)
          )
            observeMovement(observation.movement, callout, bar);
          observation.lastBar = bar.end;
          if (
            terminalAt !== undefined &&
            bar.end >= terminalAt &&
            (family !== 'strategy_entry' || observation.execution?.status !== 'open')
          )
            break;
          if (horizon !== undefined && bar.start >= horizon) break;
        }
        const expired =
          horizon !== undefined &&
          horizon < cutoff &&
          (family !== 'strategy_entry' ||
            expectedIntraday(horizon, cutoff, callout.instrument.market, sessions).length > 0);
        const exhausted =
          observation.incomplete ||
          (observation.terminal &&
            (family !== 'strategy_entry' ||
              (observation.execution && observation.execution.status !== 'open')));
        // Process bounded slices before deciding a window has exhausted its cached data.
        const caughtUp =
          expected.length <= 512 ||
          observation.incomplete ||
          (horizon !== undefined && observation.lastBar > horizon) ||
          (terminalAt !== undefined && observation.lastBar >= terminalAt && exhausted);
        if (
          observation.movement &&
          observation.terminal &&
          (observation.lastBar >= observation.terminal.marketTime || observation.incomplete)
        ) {
          const diagnostic = finishDiagnostics(
            observation.sampleId,
            callout,
            family,
            observation.movement,
            observation.terminal,
            observation.incomplete,
            now,
          );
          this.store.db
            .prepare('INSERT OR IGNORE INTO learning_diagnostics VALUES(?,?,?)')
            .run(observation.sampleId, now, JSON.stringify(diagnostic));
        }
        if (
          caughtUp &&
          ((observation.terminal && exhausted) || expired || now - callout.marketTime > 120 * DAY)
        ) {
          if (
            family === 'strategy_entry' &&
            (!observation.execution ||
              observation.execution.status === 'open' ||
              observation.incomplete)
          )
            observation.execution = {
              status: 'unavailable',
              reason: observation.incomplete ?? 'Execution window exhausted without a usable exit',
            };
          const measurement: Measurement = {
            schema: 'execution-v1',
            sampleId: observation.sampleId,
            finalizedAt: now,
            windowEnd: terminalAt ?? horizon ?? cutoff,
            execution: observation.execution,
            incomplete:
              observation.incomplete ??
              (!observation.terminal ? 'Original outcome unavailable' : undefined),
          };
          if (observation.movement) {
            const diagnostic = finishDiagnostics(
              observation.sampleId,
              callout,
              family,
              observation.movement,
              observation.terminal,
              measurement.incomplete,
              now,
            );
            this.store.db
              .prepare('INSERT OR IGNORE INTO learning_diagnostics VALUES(?,?,?)')
              .run(observation.sampleId, now, JSON.stringify(diagnostic));
          }
          this.store.db
            .prepare('INSERT OR IGNORE INTO learning_measurements VALUES(?,?)')
            .run(observation.sampleId, JSON.stringify(measurement));
          this.store.db
            .prepare('DELETE FROM learning_observations WHERE sample_id=?')
            .run(observation.sampleId);
        } else
          this.store.db
            .prepare('UPDATE learning_observations SET updated_at=?,body=? WHERE sample_id=?')
            .run(now, JSON.stringify(observation), observation.sampleId);
      });
  }
}
