import type { Store } from '../sql-store.js';
import type { Bar, Instrument, Interval, SignalEvent } from '../domain.js';
import { stableId } from '../core/strategy.js';
import { DAY } from '../core/time.js';

export function observeSource(
  store: Store,
  instrument: Instrument,
  interval: Interval,
  bars: Bar[],
  at: number,
) {
  // Warm-up history is not evidence that an old price was available in real time.
  const insert = store.db.prepare('INSERT OR IGNORE INTO source_observations VALUES(?,?,?,?,?,?)');
  store.transaction(() => {
    for (const bar of bars.filter((b) => b.end >= at - 2 * DAY && b.end <= at))
      insert.run(instrument.id, interval, bar.start, stableId(bar), at, JSON.stringify(bar));
  });
}

export function sourceObservedAt(
  store: Store,
  instrument: Instrument,
  end: number,
  interval: Interval = '15m',
): number | undefined {
  const rows = store.db
    .prepare(
      'SELECT observed_at,body FROM source_observations WHERE instrument=? AND interval=? AND start>=? AND start<? ORDER BY observed_at DESC',
    )
    .all(instrument.id, interval, end - (interval === '15m' ? 900_000 : DAY), end) as {
    observed_at: number;
    body: string;
  }[];
  return rows.find((r) => (JSON.parse(r.body) as Bar).end === end)?.observed_at;
}

export function recordTiming(store: Store, event: SignalEvent, queued: boolean) {
  if (!event.strategyVersion.startsWith('br-v1-') || event.debug || event.recovery) return;
  const at = Date.now();
  const source = sourceObservedAt(
    store,
    event.instrument,
    event.marketTime,
    event.state === 'watching' ? '1d' : '15m',
  );
  store.db
    .prepare('INSERT OR IGNORE INTO entry_timings VALUES(?,?,?,?)')
    .run(event.id, source ?? null, at, queued ? at : null);
}

export function timingReport(store: Store) {
  return {
    events: Number(
      (store.db.prepare('SELECT COUNT(*) AS n FROM entry_timings').get() as { n: number }).n,
    ),
    observedSources: Number(
      (
        store.db
          .prepare('SELECT COUNT(*) AS n FROM entry_timings WHERE source_observed_at IS NOT NULL')
          .get() as { n: number }
      ).n,
    ),
    deliveries: Number(
      (store.db.prepare('SELECT COUNT(*) AS n FROM delivery_timings').get() as { n: number }).n,
    ),
    enrichmentPending: Number(
      (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM entry_enrichment WHERE status='pending'")
          .get() as { n: number }
      ).n,
    ),
    historicalTiming: 'Unknown timestamps are not reconstructed from scan or deployment times.',
  };
}
