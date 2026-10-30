import type { SignalEvent, Session } from '../domain.js';
import type { Store } from '../sql-store.js';
import { DAY, dayStart, expectedIntraday } from '../core/time.js';
import { checkIntraday } from '../core/quality.js';
import {
  beginEconomics,
  finishEconomics,
  stepEconomics,
  type EntryEconomics,
} from './execution.js';

interface Work {
  callout: SignalEvent;
  model?: EntryEconomics;
  revision: number;
  incomplete?: string;
}
export interface MeasurementV2 {
  schema: 'execution-v2';
  sampleId: string;
  finalizedAt: number;
  economics: EntryEconomics;
  incomplete?: string;
}
/** Measurements of actual published entries use their first successful delivery, not a predicted receipt. */
export class EntryMeasurements {
  constructor(readonly store: Store) {}
  start(id: string, callout: SignalEvent) {
    this.store.db.prepare('INSERT OR IGNORE INTO learning_execution_work_v2 VALUES(?,?,?)').run(
      id,
      Date.now(),
      JSON.stringify({
        callout,
        revision: this.store.get(`learning_history_revision:${callout.instrument.id}`, 0),
      } satisfies Work),
    );
  }
  process(now: number, limit = 10) {
    if (
      this.store.get('learning_paused', false) ||
      this.store.get('budget_paused', false) ||
      this.store.settings().paused
    )
      return;
    const sessions = this.store.get<{ rows: Session[] }>('calendar', { rows: [] }).rows;
    const rows = this.store.db
      .prepare(
        'SELECT sample_id,body FROM learning_execution_work_v2 ORDER BY updated_at,sample_id LIMIT ?',
      )
      .all(limit) as { sample_id: string; body: string }[];
    for (const row of rows)
      this.store.transaction(() => {
        const work = JSON.parse(row.body) as Work,
          e = work.callout;
        const timing = this.store.db
          .prepare('SELECT source_observed_at,detected_at FROM entry_timings WHERE event_id=?')
          .get(e.id) as { source_observed_at: number | null; detected_at: number } | undefined;
        const delivery = this.store.db
          .prepare('SELECT MIN(delivered_at) AS at FROM delivery_timings WHERE event_id=?')
          .get(e.id) as { at: number | null };
        if (!work.model) {
          if (delivery.at === null && now - e.recordedAt < 120 * DAY) {
            this.store.db
              .prepare('UPDATE learning_execution_work_v2 SET updated_at=? WHERE sample_id=?')
              .run(now, row.sample_id);
            return;
          }
          work.model = beginEconomics(e, {
            sourceObservedAt: timing?.source_observed_at ?? undefined,
            detectedAt: timing?.detected_at,
            deliveredAt: delivery.at ?? undefined,
          });
          if (delivery.at === null) work.incomplete = 'Missing successful delivery timestamp';
        }
        const cutoff = now - e.provenance.delayMinutes * 60_000;
        const terminalRow = this.store.db
          .prepare(
            "SELECT body FROM events WHERE idea_id=? AND json_extract(body,'$.recordedAt')<=? AND json_extract(body,'$.state') IN ('invalidated','final_target','time_exit','expired') ORDER BY seq LIMIT 1",
          )
          .get(e.ideaId, now) as { body: string } | undefined;
        const terminal = terminalRow ? (JSON.parse(terminalRow.body) as SignalEvent) : undefined;
        const config = this.store.version(e.strategyVersion);
        const horizon =
          e.instrument.market === 'crypto'
            ? dayStart(e.marketTime) + config.exitSessions * DAY
            : sessions.filter((s) => s.open >= e.marketTime)[config.exitSessions - 1]?.close;
        const bars = this.store
          .bars(e.instrument, '15m')
          .filter((b) => b.end > work.model!.lastBar && b.end <= cutoff)
          .slice(0, 128);
        if (work.revision !== this.store.get(`learning_history_revision:${e.instrument.id}`, 0))
          work.incomplete = 'Missing unchanged historical source';
        for (const bar of bars) {
          try {
            checkIntraday(
              {
                instrument: e.instrument,
                intraday: [bar],
                sessions,
              } as import('../domain.js').Dataset,
              work.model.lastBar,
              bar.end,
            );
          } catch {
            work.incomplete ??= 'Missing expected execution candle';
            break;
          }
          stepEconomics(
            work.model,
            e,
            bar,
            terminal?.state === 'time_exit' ? terminal.marketTime : horizon,
            terminal?.marketTime,
          );
          if (work.model.cases.every((c) => c.execution && c.execution.status !== 'open')) break;
        }
        const ended = work.model.cases.every((c) => c.execution && c.execution.status !== 'open');
        const exhausted =
          horizon !== undefined &&
          expectedIntraday(horizon, cutoff, e.instrument.market, sessions).length > 0 &&
          (!bars.length || work.model.lastBar >= horizon + 900_000);
        if (ended || work.incomplete || exhausted || now - e.marketTime > 120 * DAY) {
          finishEconomics(
            work.model,
            work.incomplete ??
              (!ended ? 'Missing usable exit before execution coverage ended' : undefined),
          );
          const result: MeasurementV2 = {
            schema: 'execution-v2',
            sampleId: row.sample_id,
            finalizedAt: now,
            economics: work.model,
            incomplete: work.model.incomplete,
          };
          this.store.db
            .prepare('INSERT OR IGNORE INTO learning_measurements_v2 VALUES(?,?)')
            .run(row.sample_id, JSON.stringify(result));
          this.store.db
            .prepare('DELETE FROM learning_execution_work_v2 WHERE sample_id=?')
            .run(row.sample_id);
        } else
          this.store.db
            .prepare('UPDATE learning_execution_work_v2 SET updated_at=?,body=? WHERE sample_id=?')
            .run(now, JSON.stringify(work), row.sample_id);
      });
  }
}
