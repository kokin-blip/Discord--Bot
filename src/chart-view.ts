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
  const dailyCall =
    event?.tracker !== undefined
      ? event.tracker.timeframe === '1d'
      : snapshot || event?.state === 'watching' || event?.state === 'setup_ready';
  // Default to completed 15-minute bars; explicit daily trackers keep their own timeframe.
  const useIntraday =
    event?.tracker?.timeframe === '15m' ||
    (event?.tracker?.timeframe !== '1d' && intraday.length > 0);
  const bars = (useIntraday ? intraday : daily).slice(-100);
  const context = useIntraday
    ? daily.slice(-100)
    : data.weekly.filter((b) => b.end <= cutoff).slice(-60);
  // A daily signal belongs on its daily candle, even when the primary view is 15m.
  const call = useIntraday && dailyCall ? undefined : bars.find((b) => b.end === callTime);
  const contextCall =
    useIntraday && dailyCall ? context.find((b) => b.end === callTime) : undefined;
  const exit =
    event &&
    candidate?.entry !== undefined &&
    ['final_target', 'invalidated', 'time_exit'].includes(event.state);
  const label = event?.tracker
    ? event.tracker.type === 'volume'
      ? `${event.tracker.relativeVolume.toFixed(1)}× volume`
      : event.tracker.type === 'range'
        ? `${event.tracker.relativeRange.toFixed(1)}× range${event.tracker.combinedVolume ? ' + volume' : ''}`
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
    context,
    intraday: useIntraday,
    call,
    contextCall,
    label,
  };
}
