import type { Dataset, SignalEvent, Candidate } from './domain.js';
import type { Store } from './sql-store.js';
import {
  advanceReversal,
  reversalWarning,
  reversalDetails,
  trackerHistory,
  volumeSpike,
  type TrackerCursor,
  type TrackerObservation,
} from './core/trackers.js';
import { DAY, QUARTER, expectedIntraday } from './core/time.js';

/** Runs separately from ideas: tracker events never call saveIdea or change strategy levels. */
export function trackWatchlist(store: Store, data: Dataset, now: number, recovery: boolean): void {
  const cutoff = now - data.provenance.delayMinutes * 60_000,
    settings = store.settings();
  for (const timeframe of ['1d', '15m'] as const) {
    const key = `tracker:v1:${data.instrument.id}:${timeframe}`;
    const bars = trackerHistory(data, timeframe, cutoff);
    let saved = store.get<TrackerCursor | null>(key, null);
    const firstBar = bars[0];
    if (saved && firstBar && firstBar.start > saved.lastBar) {
      const missing =
        timeframe === '15m'
          ? expectedIntraday(saved.lastBar, firstBar.start, data.instrument.market, data.sessions)
              .length > 0
          : data.instrument.market === 'crypto'
            ? firstBar.start - saved.lastBar >= DAY
            : data.sessions.some((s) => s.close > saved!.lastBar && s.close <= firstBar.start);
      // An outage beyond the bounded cache loses ordering. Rebuild silently, never advance
      // an old warning using a discontinuous five-candle confirmation window.
      if (missing) saved = null;
    }
    // Only reversal history needs reconstruction. Volume baselines use the full validated history.
    let cursor: TrackerCursor = saved ?? { lastBar: 0 };
    const first = saved
      ? bars.findIndex((b) => b.end > saved.lastBar)
      : Math.max(0, bars.length - 65);
    if (first < 0) continue;
    store.transaction(() => {
      for (let n = first; n < bars.length; n++) {
        const bar = bars[n]!;
        const publicBar =
          !!saved &&
          !recovery &&
          settings.alerts &&
          bar.end >= cutoff - (timeframe === '15m' ? 2 * QUARTER : DAY + 16 * 60_000);
        const emit = (observation: TrackerObservation) =>
          store.enqueue(trackerEvent(data, observation, now), 'watchlist');
        if (publicBar && settings.volumeSpikes) {
          const volume = volumeSpike(data, timeframe, bar, settings.volumeMultiplier, 10);
          if (
            volume?.details.type === 'volume' &&
            store.cooldown(`${key}:volume:${volume.details.pressure}`, bar.end)
          )
            emit(volume);
        }
        // A pending warning owns this candle; no second warning on its terminal candle.
        if (cursor.pending) {
          const announced = cursor.pending.announced;
          const result = advanceReversal(cursor.pending, timeframe, bar);
          cursor = { lastBar: bar.end, ...(result.pending ? { pending: result.pending } : {}) };
          if (result.observation && announced && publicBar && settings.reversals)
            emit(result.observation);
        } else {
          const pending = reversalWarning(
            data.instrument.id,
            timeframe,
            bars.slice(Math.max(0, n - 60), n),
            bar,
          );
          if (pending) {
            pending.announced =
              publicBar &&
              settings.reversals &&
              store.cooldown(`${key}:reversal:${pending.direction}`, bar.end);
            if (pending.announced)
              emit({
                id: pending.id,
                direction: pending.direction,
                bar,
                details: reversalDetails(pending, timeframe, 'warning', bar.close),
              });
          }
          cursor = { lastBar: bar.end, ...(pending ? { pending } : {}) };
        }
      }
      store.set(key, cursor);
    });
  }
}
export function trackerEvent(
  data: Dataset,
  observation: TrackerObservation,
  now: number,
): SignalEvent {
  const { id, direction, bar, details } = observation;
  const reasons = [
    details.type === 'volume'
      ? 'Unusual completed-candle volume'
      : `Experimental reversal ${details.phase}`,
  ];
  // Compatibility envelope for the existing journal. No strategy geometry is evaluated or published.
  const candidate: Candidate = {
    id,
    instrument: data.instrument,
    direction,
    strategyVersion: 'watch-tracker-v1',
    breakout: bar,
    level: 0,
    baseHigh: 0,
    baseLow: 0,
    atr: 0,
    relativeStrength: 0,
    relativeVolume: 0,
    provisionalRR: 0,
    reasons,
  };
  return {
    kind: 'watch_tracker',
    tracker: details,
    id,
    ideaId: details.type === 'reversal' ? details.warningId : id,
    instrument: data.instrument,
    direction,
    state: 'watching',
    marketTime: bar.end,
    recordedAt: now,
    strategyVersion: candidate.strategyVersion,
    reasons,
    candidate,
    provenance: { ...data.provenance, asOf: bar.end },
  };
}
