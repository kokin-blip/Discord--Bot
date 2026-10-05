import type { Bar, Dataset, Instrument, Session } from '../domain.js';
import { DAY, QUARTER, dayStart, expectedIntraday, utcDate, validateBars } from './time.js';
export function checkDaily(i: Instrument, bars: Bar[], sessions: Session[], cutoff: number): void {
  validateBars(bars);
  if (bars.length < 252) throw new Error('INSUFFICIENT_HISTORY');
  const dates = new Set(bars.map((b) => utcDate(b.start)));
  const start = bars[0]!.start;
  const expected =
    i.market === 'crypto'
      ? Array.from({ length: Math.floor((dayStart(cutoff) - dayStart(start)) / DAY) }, (_, n) =>
          utcDate(start + n * DAY),
        )
      : sessions.filter((s) => s.open >= start && s.close <= cutoff).map((s) => s.date);
  if (!expected.every((d) => dates.has(d))) throw new Error('MISSING_DAILY_BARS');
  if (bars.some((b) => b.end > cutoff)) throw new Error('INCOMPLETE_DAILY_BAR');
}
export function checkIntraday(data: Dataset, from: number, cutoff: number): void {
  validateBars(data.intraday);
  const expected = expectedIntraday(from, cutoff, data.instrument.market, data.sessions),
    actual = new Set(data.intraday.map((b) => b.start));
  if (!expected.every((t) => actual.has(t))) throw new Error('MISSING_INTRADAY_BARS');
  if (data.intraday.some((b) => b.end > cutoff || b.end - b.start !== QUARTER))
    throw new Error('INCOMPLETE_INTRADAY_BAR');
}
export function historyChanged(previous: Bar[], refreshed: Bar[]): boolean {
  const old = new Map(previous.map((b) => [b.start, b]));
  return refreshed.some((b) => {
    const p = old.get(b.start);
    return (
      p !== undefined &&
      ['open', 'high', 'low', 'close', 'volume'].some(
        (k) => Math.abs(p[k as keyof Bar] - b[k as keyof Bar]) > 1e-8,
      )
    );
  });
}
