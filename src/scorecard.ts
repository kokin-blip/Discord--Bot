import type { SignalEvent } from './domain.js';
import type { SqlDatabase, Store } from './sql-store.js';
import { calloutOutcome, type CalloutFamily, type CalloutOutcome } from './callout-outcomes.js';
import { realCall } from './learning-observations.js';
import type { OutcomeSample } from './shadow-learning.js';

export function initializeScorecardSchema(db: SqlDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scorecard_sources(event_id TEXT PRIMARY KEY,idea_id TEXT NOT NULL,family TEXT NOT NULL,issued_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS scorecard_sources_call ON scorecard_sources(idea_id,family);
    CREATE TABLE IF NOT EXISTS scorecard_results(idea_id TEXT NOT NULL,family TEXT NOT NULL,outcome TEXT NOT NULL,resolved_at INTEGER NOT NULL,source_id TEXT NOT NULL,priority INTEGER NOT NULL,PRIMARY KEY(idea_id,family));
  `);
}
export interface ScorecardCounts {
  success: number;
  failure: number;
  pending: number;
  unconfirmed: number;
  ambiguous: number;
  unknown: number;
}
const empty = (): ScorecardCounts => ({
  success: 0,
  failure: 0,
  pending: 0,
  unconfirmed: 0,
  ambiguous: 0,
  unknown: 0,
});
const families: CalloutFamily[] = ['strategy_entry', 'strategy_setup', 'reversal_warning'];
const outcomes: CalloutOutcome[] = ['success', 'failure', 'unconfirmed', 'ambiguous', 'unknown'];
function eligible(e: SignalEvent) {
  return (
    realCall(e) &&
    ((e.tracker?.type === 'reversal' && e.kind === 'watch_tracker') ||
      e.kind === 'lifecycle' ||
      e.kind === 'setup_snapshot' ||
      (!e.kind && e.strategyVersion.startsWith('br-v1-')))
  );
}
function opening(e: SignalEvent): CalloutFamily | undefined {
  if (e.tracker?.type === 'reversal')
    return e.tracker.phase === 'warning' ? 'reversal_warning' : undefined;
  if (e.state === 'entry_triggered') return 'strategy_entry';
  if (['watching', 'setup_ready'].includes(e.state)) return 'strategy_setup';
  return undefined;
}
export class Scorecard {
  constructor(readonly store: Store) {}
  private source(e: SignalEvent, family: CalloutFamily) {
    if (!eligible(e)) return;
    this.store.db
      .prepare('INSERT OR IGNORE INTO scorecard_sources VALUES(?,?,?,?)')
      .run(e.id, e.ideaId, family, e.marketTime);
  }
  private result(
    e: SignalEvent,
    family: CalloutFamily,
    outcome: CalloutOutcome,
    source: string,
    priority: number,
  ) {
    this.store.db
      .prepare(
        `INSERT INTO scorecard_results VALUES(?,?,?,?,?,?)
      ON CONFLICT(idea_id,family) DO UPDATE SET outcome=excluded.outcome,resolved_at=excluded.resolved_at,source_id=excluded.source_id,priority=excluded.priority
      WHERE excluded.priority>scorecard_results.priority`,
      )
      .run(e.ideaId, family, outcome, e.marketTime, source, priority);
  }
  /** Projection work has its own cursors; learning pauses never erase lifetime coverage. */
  process(now: number, limit = 100) {
    if (this.store.get('budget_paused', false)) return;
    this.store.transaction(() => {
      const events = this.store.db
        .prepare('SELECT seq,body FROM events WHERE seq>? ORDER BY seq LIMIT ?')
        .all(this.store.get('scorecard_event_cursor', 0), limit) as { seq: number; body: string }[];
      for (const row of events) {
        const e: SignalEvent = JSON.parse(row.body);
        if (eligible(e)) {
          const family = opening(e);
          if (family) this.source(e, family);
          const result = calloutOutcome(e);
          if (result && (!family || e.state === 'entry_triggered'))
            this.result(
              e,
              e.tracker?.type === 'reversal'
                ? 'reversal_warning'
                : e.state === 'entry_triggered' || e.candidate.entry === undefined
                  ? 'strategy_setup'
                  : 'strategy_entry',
              result,
              e.id,
              1,
            );
        }
      }
      if (events.length) {
        this.store.set('scorecard_event_cursor', events.at(-1)!.seq);
        this.store.set(
          'scorecard_event_time',
          (JSON.parse(events.at(-1)!.body) as SignalEvent).recordedAt,
        );
      }
      const daily = this.store.db
        .prepare(
          'SELECT rowid AS cursor,id,callout_id,day,body FROM daily_outcomes WHERE rowid>? ORDER BY rowid LIMIT ?',
        )
        .all(this.store.get('scorecard_daily_cursor', 0), limit) as {
        cursor: number;
        id: string;
        callout_id: string;
        day: string;
        body: string;
      }[];
      for (const row of daily) {
        const record = JSON.parse(row.body) as { family: CalloutFamily; outcome: CalloutOutcome };
        const origin = this.store.db
          .prepare('SELECT body FROM events WHERE id=?')
          .get(row.callout_id) as { body: string } | undefined;
        if (origin && families.includes(record.family) && outcomes.includes(record.outcome)) {
          const e: SignalEvent = JSON.parse(origin.body);
          if (eligible(e)) {
            this.source(e, record.family);
            this.result(
              { ...e, marketTime: Date.parse(`${row.day}T00:00:00-07:00`) },
              record.family,
              record.outcome,
              row.id,
              2,
            );
          }
        }
      }
      if (daily.length) this.store.set('scorecard_daily_cursor', daily.at(-1)!.cursor);
      const journal = this.store.db
        .prepare(
          'SELECT rowid AS cursor,body FROM learning_journal WHERE rowid>? ORDER BY rowid LIMIT ?',
        )
        .all(this.store.get('scorecard_learning_cursor', 0), limit) as {
        cursor: number;
        body: string;
      }[];
      for (const row of journal) {
        const sample: OutcomeSample = JSON.parse(row.body);
        if (
          eligible(sample.callout) &&
          realCall(sample.terminal) &&
          families.includes(sample.family) &&
          outcomes.includes(sample.outcome)
        ) {
          this.source(sample.callout, sample.family);
          this.result(sample.terminal, sample.family, sample.outcome, sample.id, 3);
        }
      }
      if (journal.length) this.store.set('scorecard_learning_cursor', journal.at(-1)!.cursor);
      this.store.set('scorecard_processed_at', now);
    });
  }
  summary() {
    const groups = Object.fromEntries(families.map((f) => [f, empty()])) as Record<
      CalloutFamily,
      ScorecardCounts
    >;
    const delivered = `SELECT s.idea_id,s.family,MIN(s.issued_at) AS issued_at FROM scorecard_sources s
      WHERE EXISTS(SELECT 1 FROM delivery_receipts r WHERE r.event_id=s.event_id) GROUP BY s.idea_id,s.family`;
    const rows = this.store.db
      .prepare(
        `WITH delivered AS (${delivered})
      SELECT d.family,COALESCE(r.outcome,'pending') AS outcome,COUNT(*) AS n,MIN(d.issued_at) AS since
      FROM delivered d LEFT JOIN scorecard_results r ON r.idea_id=d.idea_id AND r.family=d.family GROUP BY d.family,outcome`,
      )
      .all() as {
      family: CalloutFamily;
      outcome: keyof ScorecardCounts;
      n: number;
      since: number;
    }[];
    for (const row of rows) groups[row.family][row.outcome] = row.n;
    const latest = (table: string, column: string) =>
      Number(
        (
          this.store.db.prepare(`SELECT COALESCE(MAX(${column}),0) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
      );
    const cursors = {
      events: {
        processed: this.store.get('scorecard_event_cursor', 0),
        latest: latest('events', 'seq'),
      },
      learning: {
        processed: this.store.get('scorecard_learning_cursor', 0),
        latest: latest('learning_journal', 'rowid'),
      },
      daily: {
        processed: this.store.get('scorecard_daily_cursor', 0),
        latest: latest('daily_outcomes', 'rowid'),
      },
    };
    const gaps = this.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM scorecard_results r
      WHERE NOT EXISTS(SELECT 1 FROM scorecard_sources s WHERE s.idea_id=r.idea_id AND s.family=r.family)
      AND EXISTS(SELECT 1 FROM events e JOIN delivery_receipts d ON d.event_id=e.id WHERE e.idea_id=r.idea_id)`,
      )
      .get() as { n: number };
    return {
      groups,
      coverage: {
        since: rows.length ? Math.min(...rows.map((r) => r.since)) : null,
        processedAt: this.store.get<number | null>('scorecard_processed_at', null),
        lastEventAt: this.store.get<number | null>('scorecard_event_time', null),
        caughtUp: Object.values(cursors).every((c) => c.processed >= c.latest),
        cursors,
        historicalGaps: gaps.n,
        error: this.store.get('scorecard_error', null),
      },
    };
  }
  text() {
    const { groups, coverage } = this.summary();
    const uncertain = (c: ScorecardCounts) =>
      `Pending ${c.pending} · unconfirmed ${c.unconfirmed} · ambiguous ${c.ambiguous} · unknown ${c.unknown}`;
    return [
      '**Lifetime callout scorecard**',
      `Confirmed entries: **${groups.strategy_entry.success} correct · ${groups.strategy_entry.failure} wrong**\n${uncertain(groups.strategy_entry)}`,
      `Setups: **${groups.strategy_setup.success} qualified · ${groups.strategy_setup.failure} failed**\n${uncertain(groups.strategy_setup)}`,
      `Reversal warnings: **${groups.reversal_warning.success} confirmed · ${groups.reversal_warning.failure} cancelled**\n${uncertain(groups.reversal_warning)}`,
      `Retained delivered history since ${coverage.since === null ? 'no delivered callouts yet' : new Date(coverage.since).toISOString()}. Includes real historical calls from the former test channel.`,
      `${coverage.caughtUp ? 'Indexed through the latest retained event.' : 'Historical backfill in progress; totals are partial.'} Last processed: ${coverage.processedAt === null ? 'not yet' : new Date(coverage.processedAt).toISOString()}. Last event: ${coverage.lastEventAt === null ? 'none' : new Date(coverage.lastEventAt).toISOString()}.`,
      `Historical outcomes missing their originating callout: ${coverage.historicalGaps}. History predating retained records cannot be reconstructed.${coverage.error ? ' Processing is delayed; see /status.' : ''}`,
      'Each idea counts once per category. Setup qualification and reversal confirmation are separate from entry results. Signal reference prices, not fills or realized profit.',
    ].join('\n\n');
  }
}
