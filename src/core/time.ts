import type { Bar, Market, Session } from '../domain.js';
export const DAY = 86_400_000;
export const QUARTER = 900_000;
export const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);
export const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
export function weekStart(t: number) {
  const day = new Date(t).getUTCDay();
  return dayStart(t) - ((day + 6) % 7) * DAY;
}
export function completed(bars: Bar[], now: number) {
  return bars.filter((b) => b.end <= now).sort((a, b) => a.start - b.start);
}
export function validateBars(bars: Bar[]): void {
  let last = -Infinity;
  for (const b of bars) {
    if (
      ![b.start, b.end, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
      b.start <= last ||
      b.end <= b.start ||
      b.low <= 0 ||
      b.volume < 0 ||
      b.high < Math.max(b.open, b.close, b.low) ||
      b.low > Math.min(b.open, b.close)
    )
      throw new Error('Invalid, duplicate, or unordered market bars');
    last = b.start;
  }
}
export function weeklyBars(daily: Bar[], market: Market, sessions: Session[], now: number): Bar[] {
  const groups = new Map<number, Bar[]>();
  for (const b of completed(daily, now)) {
    const w = weekStart(b.start);
    groups.set(w, [...(groups.get(w) ?? []), b]);
  }
  const result: Bar[] = [];
  for (const [start, bars] of groups) {
    const expected =
      market === 'crypto'
        ? Array.from({ length: 7 }, (_, i) => utcDate(start + i * DAY))
        : sessions.filter((s) => weekStart(Date.parse(s.date)) === start).map((s) => s.date);
    const end =
      market === 'crypto'
        ? start + 7 * DAY
        : Math.max(
            ...sessions.filter((s) => weekStart(Date.parse(s.date)) === start).map((s) => s.close),
          );
    if (
      !expected.length ||
      end > now ||
      !expected.every((d) => bars.some((b) => utcDate(b.start) === d))
    )
      continue;
    result.push({
      start,
      end,
      open: bars[0]!.open,
      close: bars.at(-1)!.close,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      volume: bars.reduce((a, b) => a + b.volume, 0),
    });
  }
  return result;
}
export function sessionsAfter(
  from: number,
  to: number,
  market: Market,
  sessions: Session[],
): number {
  if (market === 'crypto') return Math.max(0, Math.floor((dayStart(to) - dayStart(from)) / DAY));
  return sessions.filter((s) => s.open >= from && s.close <= to).length;
}
export function expectedIntraday(
  start: number,
  end: number,
  market: Market,
  sessions: Session[],
): number[] {
  const result: number[] = [];
  if (market === 'crypto') {
    for (let t = Math.ceil(start / QUARTER) * QUARTER; t + QUARTER <= end; t += QUARTER)
      result.push(t);
  } else
    for (const s of sessions)
      for (let t = s.open; t + QUARTER <= s.close && t + QUARTER <= end; t += QUARTER)
        if (t >= start) result.push(t);
  return result;
}
