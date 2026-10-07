import type { Dataset, Direction, LearningFeatures } from '../domain.js';
import { atr, mean, sma } from './indicators.js';
export function benchmarkTrend(data: Dataset, time: number): LearningFeatures['benchmarkTrend'] {
  const bars = data.benchmark.filter((b) => b.end <= time);
  const average = sma(bars, 50),
    close = bars.at(-1)?.close;
  return !Number.isFinite(average) || close === undefined
    ? 'unknown'
    : close > average
      ? 'up'
      : close < average
        ? 'down'
        : 'flat';
}
export function agrees(trend: LearningFeatures['benchmarkTrend'], direction: Direction): boolean {
  return trend === (direction === 'bullish' ? 'up' : 'down');
}
export function learningFeatures(
  data: Dataset,
  time: number,
  direction: Direction,
): LearningFeatures {
  const daily = data.daily.filter((b) => b.end <= time),
    bar = daily.at(-1);
  const baseline = daily.length >= 21 ? mean(daily.slice(-21, -1).map((b) => b.volume)) : NaN;
  const volatility = atr(daily, 14);
  const callCandle = data.intraday.find((b) => b.end === time) ?? daily.find((b) => b.end === time);
  return {
    at: time,
    ...(callCandle ? { close: callCandle.close } : {}),
    ...(callCandle
      ? {
          pressure:
            callCandle.close > callCandle.open
              ? ('buying' as const)
              : callCandle.close < callCandle.open
                ? ('selling' as const)
                : ('neutral' as const),
          pressureBasis: 'candle_direction' as const,
        }
      : {}),
    benchmarkTrend: benchmarkTrend(data, time),
    benchmarkAgreement: agrees(benchmarkTrend(data, time), direction),
    ...(baseline > 0 && bar ? { dailyRelativeVolume: bar.volume / baseline } : {}),
    ...(Number.isFinite(volatility) ? { atr: volatility } : {}),
  };
}
