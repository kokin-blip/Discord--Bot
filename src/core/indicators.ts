import type { Bar } from '../domain.js';
export const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
export function sma(bars: Bar[], period: number): number {
  return bars.length >= period ? mean(bars.slice(-period).map((b) => b.close)) : NaN;
}
export function atr(bars: Bar[], period: number): number {
  if (bars.length < period + 1) return NaN;
  const ranges = bars
    .slice(1)
    .map((b, i) =>
      Math.max(b.high - b.low, Math.abs(b.high - bars[i]!.close), Math.abs(b.low - bars[i]!.close)),
    );
  let value = mean(ranges.slice(0, period));
  for (const range of ranges.slice(period)) value = (value * (period - 1) + range) / period;
  return value;
}
export function relativeStrength(asset: Bar[], benchmark: Bar[], period: number): number {
  const lookup = new Map(benchmark.map((b) => [new Date(b.start).toISOString().slice(0, 10), b]));
  const aligned = asset.flatMap((b) => {
    const ref = lookup.get(new Date(b.start).toISOString().slice(0, 10));
    return ref ? [{ a: b.close, b: ref.close }] : [];
  });
  if (aligned.length < period + 1) return NaN;
  const first = aligned.at(-period - 1)!,
    last = aligned.at(-1)!;
  return last.a / last.b / (first.a / first.b) - 1;
}
