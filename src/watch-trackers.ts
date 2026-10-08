import { stableId } from './core/strategy.js';
import { currentReversal } from './reversal-config.js';
import { learningFeatures, agrees, benchmarkTrend } from './core/learning-features.js';
import type { Dataset, SignalEvent, Candidate } from './domain.js';
import type { Store } from './sql-store.js';
import {
  advanceReversal,
  reversalWarning,
  reversalDetails,
  trackerHistory,
  volumeSpike,
  rangeExpansion,
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
        if (publicBar) {
          const volume = settings.volumeSpikes
            ? volumeSpike(data, timeframe, bar, settings.volumeMultiplier, 10)
            : undefined;
          const range = settings.rangeExpansion
            ? rangeExpansion(data, timeframe, bar, settings.rangeMultiplier, 10, cutoff)
            : undefined;
          const volumeKey =
            volume?.details.type === 'volume'
              ? `${key}:volume:${volume.details.pressure}`
              : undefined;
          const rangeKey =
            range?.details.type === 'range'
              ? `${key}:range:${range.details.candleDirection}`
              : undefined;
          const volumeAllowed = volumeKey ? store.cooldown(volumeKey, bar.end) : false;
          const rangeAllowed = rangeKey ? store.cooldown(rangeKey, bar.end) : false;
          if (range?.details.type === 'range' && volume?.details.type === 'volume') {
            if (volumeAllowed || rangeAllowed) {
              // A combined delivery covers both trackers, including one still cooling down.
              store.markCooldown(volumeKey!, bar.end);
              store.markCooldown(rangeKey!, bar.end);
              range.details.combinedVolume = true;
              range.details.volumeMultiplier = settings.volumeMultiplier;
              emit(range);
            }
          } else {
            if (range && rangeAllowed) emit(range);
            if (volume && volumeAllowed) emit(volume);
          }
        }
        // A pending warning owns this candle; no second warning on its terminal candle.
        if (cursor.pending) {
          const announced = cursor.pending.announced;
          const version = cursor.pending.strategyVersion ?? 'watch-tracker-v1';
          const result = advanceReversal(cursor.pending, timeframe, bar);
          cursor = { lastBar: bar.end, ...(result.pending ? { pending: result.pending } : {}) };
          if (result.observation && announced) {
            const event = trackerEvent(data, result.observation, now, version);
            if (publicBar && settings.reversals) store.enqueue(event, 'watchlist');
            else {
              event.recovery = true;
              store.recordEvent(event);
            }
          }
        } else {
          let pending = reversalWarning(
            data.instrument.id,
            timeframe,
            bars.slice(Math.max(0, n - 60), n),
            bar,
          );
          const reversal = currentReversal(store);
          if (
            pending &&
            reversal.config.benchmarkAgreement &&
            !agrees(benchmarkTrend(data, bar.end), pending.direction)
          )
            pending = undefined;
          if (pending) {
            pending.id = stableId(pending.id, reversal.version);
            pending.strategyVersion = reversal.version;
            pending.confirmationBars = reversal.config.confirmationBars;
            pending.announced =
              publicBar &&
              settings.reversals &&
              store.cooldown(`${key}:reversal:${pending.direction}`, bar.end);
            if (pending.announced)
              store.enqueue(
                trackerEvent(
                  data,
                  {
                    id: pending.id,
                    direction: pending.direction,
                    bar,
                    details: reversalDetails(pending, timeframe, 'warning', bar.close),
                  },
                  now,
                  pending.strategyVersion,
                ),
                'watchlist',
              );
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
  version = 'watch-tracker-v1',
): SignalEvent {
  const { id, direction, bar, details } = observation;
  const volume =
    details.timeframe === '15m' ? volumeSpike(data, '15m', bar, 0, 10)?.details : undefined;
  const reasons = [
    details.type === 'volume'
      ? 'Unusual completed-candle volume'
      : details.type === 'range'
        ? 'Unusual completed-candle range expansion'
        : `Experimental reversal ${details.phase}`,
  ];
  // Compatibility envelope for the existing journal. No strategy geometry is evaluated or published.
  const candidate: Candidate = {
    id,
    instrument: data.instrument,
    direction,
    strategyVersion: version,
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
    learning: {
      ...learningFeatures(data, bar.end, direction),
      ...(details.type === 'reversal'
        ? {
            frozenHigh: details.frozenHigh,
            frozenLow: details.frozenLow,
            cancellationLevel: details.cancellationLevel,
          }
        : {}),
      ...(volume?.type === 'volume' ? { intradayRelativeVolume: volume.relativeVolume } : {}),
      pressure: bar.close > bar.open ? 'buying' : bar.close < bar.open ? 'selling' : 'neutral',
      pressureBasis: 'candle_direction',
    },
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
