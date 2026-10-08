import type { SignalEvent } from './domain.js';
import type { Store } from './sql-store.js';
import { announcement } from './announcements.js';
import { stableId } from './core/strategy.js';
import type { Experiment, Family } from './learning.js';

const DAY = 86_400_000;
// Phoenix observes UTC-7 year-round, including weekends and market holidays.
export const phoenixDay = (time: number): string =>
  new Date(time - 7 * 3_600_000).toISOString().slice(0, 10);
const midnight = (day: string): number => Date.parse(`${day}T00:00:00-07:00`);
export type DailyOutcome = 'success' | 'failure' | 'unconfirmed' | 'ambiguous' | 'unknown';
interface Resolution {
  family: Family;
  outcome: DailyOutcome;
  experiments: { id: string; pass: boolean }[];
}
export class DailyRecap {
  constructor(readonly store: Store) {}
  initialize(now: number) {
    if (this.store.get('daily_recap_since', null) !== null) return;
    this.store.transaction(() => {
      this.store.set('daily_recap_since', now);
      this.store.set('daily_recap_next', phoenixDay(now));
    });
  }
  record(callout: SignalEvent, terminal: SignalEvent, resolution: Resolution) {
    const since = this.store.get('daily_recap_since', Infinity);
    if (
      callout.debug ||
      callout.recovery ||
      terminal.debug ||
      terminal.recovery ||
      terminal.recordedAt < since
    )
      return;
    // Silent journal/replay samples have no intended public delivery.
    if (!this.store.db.prepare('SELECT 1 FROM outbox WHERE event_id=?').get(callout.id)) return;
    this.store.db
      .prepare('INSERT OR IGNORE INTO daily_outcomes(id,callout_id,day,body) VALUES(?,?,?,?)')
      .run(
        stableId('daily-outcome', callout.id, resolution.family),
        callout.id,
        phoenixDay(terminal.marketTime),
        JSON.stringify(resolution),
      );
  }
  activity(experiment: Experiment, action: string, now: number) {
    this.store.db.prepare('INSERT OR IGNORE INTO learning_activity VALUES(?,?,?)').run(
      stableId('learning-activity', experiment.id, action, String(now)),
      phoenixDay(now),
      JSON.stringify({
        id: experiment.id,
        filter: experiment.filter,
        action,
        version: experiment.promotedVersion ?? experiment.version,
      }),
    );
  }
  queue(now: number) {
    const day = this.store.get('daily_recap_next', phoenixDay(now));
    if (day >= phoenixDay(now)) return;
    // A source call still awaiting delivery must not silently disappear from the scorecard.
    const awaiting = this.store.db
      .prepare(
        "SELECT count(*) AS n FROM daily_outcomes d JOIN outbox o ON o.event_id=d.callout_id WHERE d.reported_day IS NULL AND d.day<=? AND o.status='pending'",
      )
      .get(day) as { n: number };
    if (awaiting.n) return;
    this.store.transaction(() => {
      const rows = this.store.db
        .prepare(
          'SELECT d.id,d.day,d.body FROM daily_outcomes d WHERE d.reported_day IS NULL AND d.day<=? AND EXISTS(SELECT 1 FROM delivery_receipts r WHERE r.event_id=d.callout_id) ORDER BY d.day,d.id',
        )
        .all(day) as { id: string; day: string; body: string }[];
      const resolutions = rows.map((r) => JSON.parse(r.body) as Resolution);
      const families: [Family, string, string, string][] = [
        ['strategy_entry', 'Confirmed entries', 'right', 'wrong'],
        ['strategy_setup', 'Setups', 'qualified', 'failed'],
        ['reversal_warning', 'Reversal warnings', 'confirmed', 'cancelled'],
      ];
      const lines = families.map(([family, label, right, wrong]) => {
        const counts = (outcome: DailyOutcome) =>
          resolutions.filter((r) => r.family === family && r.outcome === outcome).length;
        return `${label}: **${counts('success')} ${right} · ${counts('failure')} ${wrong}**\nUnconfirmed ${counts('unconfirmed')} · ambiguous ${counts('ambiguous')} · unknown ${counts('unknown')}`;
      });
      const pending = this.store.db
        .prepare(
          "SELECT count(*) AS n FROM learning_pending p WHERE EXISTS(SELECT 1 FROM delivery_receipts r WHERE r.event_id=json_extract(p.body,'$.event.id'))",
        )
        .get() as { n: number };
      lines.push(
        `Still pending at report time: ${pending.n}. Counts cover outcomes resolved on ${day}; setup qualification and reversal confirmation are not entry wins. Entry results use signal reference prices, not fills or realized profit.`,
      );
      const late = rows.filter((r) => r.day < day).length;
      if (late)
        lines.push(`Includes ${late} delayed outcomes from earlier days, not previously reported.`);
      const undelivered = this.store.db
        .prepare(
          "SELECT count(*) AS n FROM daily_outcomes d JOIN outbox o ON o.event_id=d.callout_id WHERE d.reported_day IS NULL AND d.day<=? AND o.status='dead' AND NOT EXISTS(SELECT 1 FROM delivery_receipts r WHERE r.event_id=d.callout_id)",
        )
        .get(day) as { n: number };
      if (undelivered.n)
        lines.push(
          `${undelivered.n} outcomes excluded because their original callouts could not be delivered; operator review is required. They can appear as delayed outcomes after successful delivery.`,
        );
      const activity = this.store.db
        .prepare('SELECT body FROM learning_activity WHERE day=? ORDER BY rowid')
        .all(day) as { body: string }[];
      const learning = activity.map((r) => {
        const a = JSON.parse(r.body) as {
          id: string;
          filter: string;
          action: string;
          version: string;
        };
        return `${a.id} (${a.filter}): ${a.action}; version ${a.version}.`;
      });
      const shadow = new Map<string, { failures: number; successes: number; retained: number }>();
      for (const r of resolutions)
        for (const assignment of r.experiments) {
          const count = shadow.get(assignment.id) ?? { failures: 0, successes: 0, retained: 0 };
          if (assignment.pass) count.retained++;
          else if (r.outcome === 'failure') count.failures++;
          else if (r.outcome === 'success') count.successes++;
          shadow.set(assignment.id, count);
        }
      for (const [id, c] of shadow)
        learning.push(
          `${id}: in shadow testing, would have excluded ${c.failures} failed and ${c.successes} successful callouts; retained ${c.retained} outcomes. This is filter evidence, not demonstrated live improvement.`,
        );
      const failures = resolutions.filter((r) => r.outcome === 'failure').length;
      if (failures)
        learning.unshift(
          `${failures} failures contributed observations for filter testing; associations do not establish causes.`,
        );
      lines.push(
        `**Learning**\n${learning.length ? learning.join('\n') : 'No new learning changes or shadow results to report.'}\nLive rule changes require manager approval; a promotion is not proof of improved performance.`,
      );
      if (this.store.get('last_error', null) || this.store.get('learning_error', null))
        lines.push(
          'Data/processing warning: an operational error is recorded. These totals cover observed outcomes; unresolved calls are not assumed successful.',
        );
      if (this.store.get('daily_recap_since', 0) > midnight(day))
        lines.push('First recap covers a partial day from feature activation.');
      this.store.enqueue(
        announcement(
          stableId('daily-recap', day, 'America/Phoenix'),
          `Daily callout recap · ${day} · America/Phoenix`,
          lines.join('\n\n'),
          now,
        ),
        'summaries',
      );
      for (const row of rows)
        this.store.db
          .prepare('UPDATE daily_outcomes SET reported_day=? WHERE id=? AND reported_day IS NULL')
          .run(day, row.id);
      this.store.set('daily_recap_next', phoenixDay(midnight(day) + DAY));
    });
  }
}
