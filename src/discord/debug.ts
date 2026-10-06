import type { Dataset, SignalEvent } from '../domain.js';
import { crypto } from '../domain.js';
import type { Store } from '../sql-store.js';
import { DAY, QUARTER, weeklyBars } from '../core/time.js';
import { volumeSpike, trackerHistory, type TrackerCursor } from '../core/trackers.js';
import { trackerEvent } from '../watch-trackers.js';
import { stableId } from '../core/strategy.js';

export function debugReport(
  store: Store,
  now: number,
  runtimeVersion: string,
  testChannel?: string,
  symbol?: string,
) {
  const settings = store.settings();
  const watched = store.monitored();
  if (symbol && !watched.some((i) => i.symbol === symbol.toUpperCase()))
    throw new Error('Symbol is not monitored.');
  const calendar = store.get<{ rows: Dataset['sessions'] }>('calendar', { rows: [] });
  return {
    runtimeVersion,
    checkedAt: new Date(now).toISOString(),
    paused: settings.paused,
    alerts: {
      enabled: settings.alerts,
      volume: settings.volumeSpikes,
      reversals: settings.reversals,
      volumeMultiplier: settings.volumeMultiplier,
      baselineDays: 10,
    },
    lastScan: store.get('last_scan', null),
    scanProgress: store.get('scan_progress', null),
    lastError: store.get('last_error', null),
    discoveryError: store.get('discovery_error', null),
    coinbaseRetryAt: store.get('retry_after:api.exchange.coinbase.com', 0),
    testChannel: testChannel ?? null,
    watchlistChannel: settings.channels.watchlist ?? null,
    pendingDeliveries: store.pendingCount(),
    lastTest: store.get('debug_last_delivery', null),
    instruments: watched
      .filter((i) => !symbol || i.symbol === symbol.toUpperCase())
      .map((instrument) => {
        const cutoff = now - (instrument.market === 'equity' ? 16 * 60000 : 0);
        const data: Dataset = {
          instrument,
          daily: store.bars(instrument, '1d'),
          intraday: store.bars(instrument, '15m'),
          weekly: [],
          benchmark: [],
          sessions: calendar.rows,
          provenance: {
            provider: instrument.market === 'crypto' ? 'Coinbase' : 'Alpaca',
            feed: 'Cached candles',
            delayMinutes: instrument.market === 'equity' ? 16 : 0,
            asOf: cutoff,
          },
        };
        return {
          symbol: instrument.symbol,
          pausedReason: store.get(`quality:${instrument.id}`, null),
          timeframes: (['1d', '15m'] as const).map((timeframe) => {
            const cursor = store.get<TrackerCursor | null>(
              `tracker:v1:${instrument.id}:${timeframe}`,
              null,
            );
            try {
              const bars = trackerHistory(data, timeframe, cutoff),
                bar = bars.at(-1);
              const duration = timeframe === '15m' ? QUARTER : DAY;
              const session = calendar.rows
                .filter((s) => (timeframe === '1d' ? s.close <= cutoff : s.open <= cutoff))
                .at(-1);
              const expectedEnd =
                instrument.market === 'crypto'
                  ? Math.floor(cutoff / duration) * duration
                  : session
                    ? timeframe === '1d'
                      ? session.close
                      : Math.min(
                          session.close,
                          session.open + Math.floor((cutoff - session.open) / QUARTER) * QUARTER,
                        )
                    : null;
              const measurement = bar
                ? volumeSpike(data, timeframe, bar, 0, 10)?.details
                : undefined;
              return {
                timeframe,
                bars: bars.length,
                latestCompleted: bar?.end ?? null,
                latestAgeMinutes: bar ? Math.max(0, (now - bar.end) / 60000) : null,
                providerDelayMinutes: data.provenance.delayMinutes,
                stale: !bar || expectedEnd === null || bar.end < expectedEnd,
                processedThrough: cursor?.lastBar ?? null,
                warmedUp: cursor !== null,
                pendingReversal: cursor?.pending ?? null,
                volume:
                  measurement?.type === 'volume'
                    ? {
                        observed: measurement.volume,
                        baseline: measurement.baseline,
                        relativeVolume: measurement.relativeVolume,
                        pressure: measurement.pressure,
                        thresholdMet: measurement.relativeVolume >= settings.volumeMultiplier,
                      }
                    : null,
                note: measurement
                  ? 'Threshold alone does not override cooldown, recovery or alert toggles.'
                  : 'No usable volume baseline: requires all 10 prior matching days and positive baseline volume.',
              };
            } catch (e) {
              return {
                timeframe,
                error: e instanceof Error ? e.message : 'DATA_UNAVAILABLE',
                processedThrough: cursor?.lastBar ?? null,
              };
            }
          }),
        };
      }),
  };
}

/** Entirely synthetic; never call market providers or change a real idea/cursor/cooldown. */
export function debugSample(now: number, requestId: string): { data: Dataset; event: SignalEvent } {
  const end = Math.floor(now / QUARTER) * QUARTER;
  const dailyEnd = Math.floor(now / DAY) * DAY;
  const daily = Array.from({ length: 260 }, (_, n) => {
    const close = 100 + n * 0.15;
    return {
      start: dailyEnd - (260 - n) * DAY,
      end: dailyEnd - (259 - n) * DAY,
      open: close - 0.25,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    };
  });
  const intraday = Array.from({ length: 11 * 96 }, (_, n) => {
    const close = 130 + n * 0.01;
    return {
      start: end - (11 * 96 - n) * QUARTER,
      end: end - (11 * 96 - n - 1) * QUARTER,
      open: close - 0.05,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: n === 11 * 96 - 1 ? 2500 : 1000,
    };
  });
  const data: Dataset = {
    instrument: { ...crypto('BTC-USD'), venue: 'SYNTHETIC DEBUG DATA' },
    daily,
    intraday,
    weekly: weeklyBars(daily, 'crypto', [], now),
    benchmark: daily,
    sessions: [],
    provenance: {
      provider: 'DEBUG',
      feed: 'SYNTHETIC TEST · invented prices and volume',
      delayMinutes: 0,
      asOf: end,
    },
  };
  const observation = volumeSpike(data, '15m', intraday.at(-1)!, 2, 10)!;
  observation.id = stableId('debug', requestId);
  const event = trackerEvent(data, observation, now);
  event.debug = true;
  event.ideaId = observation.id;
  return { data, event };
}
