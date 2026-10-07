import type { Candidate, Dataset, SignalEvent } from './domain.js';

/** Select the exact completed call candle; never substitute a nearby candle. */
export function chartView(data: Dataset, candidate?: Candidate, event?: SignalEvent) {
  const cutoff = event?.marketTime ?? data.provenance.asOf;
  const daily = data.daily.filter((b) => b.end <= cutoff);
  const intraday = data.intraday.filter((b) => b.end <= cutoff);
  const snapshot = event?.kind === 'setup_snapshot';
  const callTime = snapshot
    ? (candidate?.retest ?? candidate?.breakout)?.end
    : (event?.marketTime ?? candidate?.confirmedAt);
  const useIntraday =
    event?.tracker?.timeframe === '15m' ||
    (!snapshot &&
      event?.state !== 'watching' &&
      event?.state !== 'setup_ready' &&
      event?.tracker?.timeframe !== '1d' &&
      callTime !== undefined &&
      intraday.some((b) => b.end === callTime));
  const bars = (useIntraday ? intraday : daily).slice(-100);
  const call = bars.find((b) => b.end === callTime);
  const exit =
    event &&
    candidate?.entry !== undefined &&
    ['final_target', 'invalidated', 'time_exit'].includes(event.state);
  const label = event?.tracker
    ? event.tracker.type === 'volume'
      ? `${event.tracker.relativeVolume.toFixed(1)}× volume`
      : `Reversal ${event.tracker.phase}`
    : snapshot
      ? 'Setup snapshot'
      : exit
        ? event.direction === 'bullish'
          ? 'SELL'
          : 'EXIT'
        : event?.state === 'entry_triggered'
          ? event.direction === 'bullish'
            ? 'BUY'
            : 'SHORT'
          : event?.state === 'setup_ready'
            ? 'Retest ready'
            : event?.state === 'watching'
              ? 'Breakout'
              : (event?.state.replaceAll('_', ' ') ??
                (candidate?.confirmedAt ? 'Entry' : 'Market chart'));
  return {
    bars,
    context: useIntraday
      ? daily.slice(-100)
      : data.weekly.filter((b) => b.end <= cutoff).slice(-60),
    intraday: useIntraday,
    call,
    label,
  };
}
