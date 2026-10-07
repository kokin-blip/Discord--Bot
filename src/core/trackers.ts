import type { Bar, Dataset, Direction, Interval, TrackerDetails } from '../domain.js';
import {
  DAY,
  QUARTER,
  completed,
  dayStart,
  expectedIntraday,
  utcDate,
  validateBars,
} from './time.js';
import { mean, sma } from './indicators.js';
import { stableId } from './strategy.js';

export interface PendingReversal {
  id: string;
  direction: Direction;
  high: number;
  low: number;
  warning: Bar;
  elapsed: number;
  announced: boolean;
  strategyVersion?: string;
  confirmationBars?: number;
}
export interface TrackerCursor {
  lastBar: number;
  pending?: PendingReversal;
}
export interface TrackerObservation {
  id: string;
  direction: Direction;
  bar: Bar;
  details: TrackerDetails;
}

// Require the expected samples, rather than quietly replacing missing data with older bars.
export function volumeSpike(
  data: Dataset,
  timeframe: Interval,
  bar: Bar,
  multiplier: number,
  days: number,
): TrackerObservation | undefined {
  const history = completed(timeframe === '1d' ? data.daily : data.intraday, bar.start);
  let samples: Bar[];
  if (timeframe === '1d') {
    const dates =
      data.instrument.market === 'crypto'
        ? Array.from({ length: days }, (_, n) => utcDate(dayStart(bar.start) - (n + 1) * DAY))
        : data.sessions
            .filter((s) => s.close <= bar.start)
            .slice(-days)
            .map((s) => s.date);
    samples = dates.flatMap((date) => history.filter((b) => utcDate(b.start) === date));
  } else {
    let starts: number[];
    if (data.instrument.market === 'crypto') {
      if (bar.start % QUARTER || bar.end - bar.start !== QUARTER) return;
      starts = Array.from({ length: days }, (_, n) => bar.start - (n + 1) * DAY);
    } else {
      const session = data.sessions.find((s) => bar.start >= s.open && bar.end <= s.close);
      if (!session || (bar.start - session.open) % QUARTER || bar.end - bar.start !== QUARTER)
        return;
      const offset = bar.start - session.open;
      starts = data.sessions
        .filter((s) => s.close <= bar.start && s.open + offset + QUARTER <= s.close)
        .slice(-days)
        .map((s) => s.open + offset);
    }
    const lookup = new Map(history.map((b) => [b.start, b]));
    samples = starts.flatMap((start) => (lookup.has(start) ? [lookup.get(start)!] : []));
  }
  if (samples.length !== days) return;
  const baseline = mean(samples.map((b) => b.volume));
  if (!(baseline > 0) || bar.volume < multiplier * baseline) return;
  const previous = history.at(-1);
  if (!previous) return;
  return {
    id: stableId('watch-tracker-v1', data.instrument.id, timeframe, 'volume', bar.end),
    direction: bar.close >= previous.close ? 'bullish' : 'bearish',
    bar,
    details: {
      type: 'volume',
      pressure: bar.close > bar.open ? 'buying' : bar.close < bar.open ? 'selling' : 'neutral',
      pressureBasis: 'candle_direction',
      timeframe,
      volume: bar.volume,
      baseline,
      relativeVolume: bar.volume / baseline,
      close: bar.close,
      priceChange: bar.close - previous.close,
      priceChangePercent: (bar.close / previous.close - 1) * 100,
      baselineDays: days,
      multiplier,
    },
  };
}

export function reversalWarning(
  instrumentId: string,
  timeframe: Interval,
  history: Bar[],
  bar: Bar,
): PendingReversal | undefined {
  const prior = completed(history, bar.start).slice(-60);
  if (prior.length < 25) return;
  const latest = prior.at(-1)!,
    average = sma(prior, 20),
    older = sma(prior.slice(0, -5), 20);
  let high: number | undefined, low: number | undefined;
  // Right-hand confirmation candles are in prior, so both pivots were known at warning open.
  for (let n = 2; n + 2 < prior.length; n++) {
    const pivot = prior[n]!,
      neighbors = [prior[n - 2]!, prior[n - 1]!, prior[n + 1]!, prior[n + 2]!];
    if (neighbors.every((b) => pivot.high > b.high)) high = pivot.high;
    if (neighbors.every((b) => pivot.low < b.low)) low = pivot.low;
  }
  if (high === undefined || low === undefined || high <= low) return;
  const direction =
    latest.close < average &&
    average < older &&
    bar.low < low &&
    bar.close > low &&
    bar.close < high
      ? 'bullish'
      : latest.close > average &&
          average > older &&
          bar.high > high &&
          bar.close < high &&
          bar.close > low
        ? 'bearish'
        : undefined;
  if (!direction) return;
  return {
    id: stableId('watch-tracker-v1', instrumentId, timeframe, 'reversal', direction, bar.end),
    direction,
    high,
    low,
    warning: bar,
    elapsed: 0,
    announced: false,
  };
}

export function advanceReversal(
  pending: PendingReversal,
  timeframe: Interval,
  bar: Bar,
): { pending?: PendingReversal; observation?: TrackerObservation } {
  if (bar.start < pending.warning.end) return { pending };
  const next = { ...pending, elapsed: pending.elapsed + 1 },
    bull = next.direction === 'bullish';
  const phase = (bull ? bar.close < next.warning.low : bar.close > next.warning.high)
    ? 'cancelled'
    : (bull ? bar.close > next.high : bar.close < next.low)
      ? 'confirmed'
      : next.elapsed >= (next.confirmationBars ?? 5)
        ? 'expired'
        : undefined;
  if (!phase) return { pending: next };
  return {
    observation: {
      id: stableId(next.id, phase, bar.end),
      direction: next.direction,
      bar,
      details: reversalDetails(next, timeframe, phase, bar.close),
    },
  };
}
export function reversalDetails(
  pending: PendingReversal,
  timeframe: Interval,
  phase: 'warning' | 'confirmed' | 'cancelled' | 'expired',
  close: number,
): TrackerDetails {
  return {
    type: 'reversal',
    timeframe,
    phase,
    warningId: pending.id,
    warningTime: pending.warning.end,
    warningClose: pending.warning.close,
    directionalChangePercent:
      pending.warning.close > 0
        ? (((pending.direction === 'bullish' ? 1 : -1) * (close - pending.warning.close)) /
            pending.warning.close) *
          100
        : undefined,
    frozenHigh: pending.high,
    frozenLow: pending.low,
    cancellationLevel: pending.direction === 'bullish' ? pending.warning.low : pending.warning.high,
    elapsed: pending.elapsed,
    confirmationBars: pending.confirmationBars ?? 5,
    close,
  };
}

export function trackerHistory(data: Dataset, timeframe: Interval, cutoff: number): Bar[] {
  const bars = completed(timeframe === '1d' ? data.daily : data.intraday, cutoff);
  validateBars(bars);
  if (timeframe === '15m' && bars.some((b) => b.end - b.start !== QUARTER))
    throw new Error('INCOMPLETE_INTRADAY_BAR');
  const actual = new Set(bars.map((b) => (timeframe === '1d' ? utcDate(b.start) : b.start)));
  const expected =
    timeframe === '15m'
      ? expectedIntraday(
          bars[0]?.start ?? cutoff,
          bars.at(-1)?.end ?? cutoff,
          data.instrument.market,
          data.sessions,
        )
      : data.instrument.market === 'equity'
        ? data.sessions
            .filter(
              (s) =>
                s.open >= (bars[0]?.start ?? cutoff) && s.close <= (bars.at(-1)?.end ?? cutoff),
            )
            .map((s) => s.date)
        : Array.from(
            {
              length: bars.length
                ? Math.floor((dayStart(bars.at(-1)!.start) - dayStart(bars[0]!.start)) / DAY) + 1
                : 0,
            },
            (_, n) => utcDate(bars[0]!.start + n * DAY),
          );
  if (!expected.every((t) => actual.has(t))) throw new Error('MISSING_TRACKER_BARS');
  return bars;
}
