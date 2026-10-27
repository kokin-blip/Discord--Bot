import { z } from 'zod';
import type { Dataset, Market, Session } from '../domain.js';
import { QUARTER, completed } from '../core/time.js';
import { baselineSamples } from '../core/trackers.js';
import { mean } from '../core/indicators.js';
import type { OptionQuote, ThresholdMonitor } from './types.js';
import { thresholdDefaults } from './types.js';

export const thresholdSchema = z
  .object({
    enabled: z.boolean().default(false),
    ideas: z.boolean().default(false),
    contracts: z.boolean().default(false),
    hours: z.number().min(1).max(24).default(4),
    progressAtr: z.number().min(0.05).max(2).default(0.25),
    contractLossPercent: z.number().min(0).max(20).default(5),
    ideaLossR: z.number().min(0).max(0.5).default(0.05),
  })
  .strict();
export { thresholdDefaults };
export const HOUR = 3_600_000;
export function marketMilliseconds(
  from: number,
  to: number,
  market: Market,
  sessions: Session[],
): number {
  if (to <= from) return 0;
  if (market === 'crypto') return to - from;
  return sessions.reduce(
    (sum, s) => sum + Math.max(0, Math.min(to, s.close) - Math.max(from, s.open)),
    0,
  );
}
export function expectedEnd(data: Dataset, cutoff: number): number | undefined {
  if (data.instrument.market === 'crypto') return Math.floor(cutoff / QUARTER) * QUARTER;
  const s = data.sessions.filter((s) => s.open + QUARTER <= cutoff).at(-1);
  return s
    ? Math.min(s.close, s.open + Math.floor((cutoff - s.open) / QUARTER) * QUARTER)
    : undefined;
}
export function marketOpen(data: Dataset, now: number): boolean {
  return (
    data.instrument.market === 'crypto' || data.sessions.some((s) => now >= s.open && now < s.close)
  );
}
export function quoteProblem(
  q: OptionQuote | undefined,
  contract: string,
  quantity: number,
  now: number,
): string | undefined {
  if (!q || q.contract !== contract) return 'QUOTE_UNAVAILABLE';
  if (
    q.feed !== 'indicative' ||
    ![q.bid, q.ask, q.bidSize, q.askSize, q.asOf].every(Number.isFinite) ||
    q.bid <= 0 ||
    q.ask < q.bid ||
    q.bidSize < quantity ||
    q.askSize < 1
  )
    return 'QUOTE_INVALID_OR_INSUFFICIENT_SIZE';
  if (q.asOf > now || now - q.asOf > 5 * 60_000) return 'QUOTE_STALE_OR_FUTURE';
  if ((q.ask - q.bid) / ((q.ask + q.bid) / 2) > 0.2 + 1e-12) return 'QUOTE_SPREAD_TOO_WIDE';
  return undefined;
}
export function returnMeasurement(m: ThresholdMonitor, close: number, quote?: OptionQuote) {
  if (m.mode === 'contract') {
    if (!quote) return undefined;
    const netPerContract = 100 * (quote.bid - m.entry) - (m.fees ?? 0);
    return {
      returnPercent: (netPerContract / (100 * m.entry)) * 100,
      estimatedNet: m.quantity * netPerContract,
    };
  }
  const movement = (m.direction === 'bullish' ? 1 : -1) * (close - m.entry);
  return { returnPercent: (movement / m.entry) * 100, rMultiple: movement / m.risk! };
}
export function returnQualifies(
  m: ThresholdMonitor,
  value: ReturnType<typeof returnMeasurement>,
  quote?: OptionQuote,
): boolean {
  if (!value) return false;
  if (m.mode === 'idea')
    return Number.isFinite(value.rMultiple) && value.rMultiple! >= -m.rules.ideaLossR - 1e-10;
  if (quote && m.stop !== undefined && quote.bid <= m.stop) return false;
  if (value.returnPercent >= -1e-10) return true;
  return (
    m.stop !== undefined &&
    !!quote &&
    quote.bid > m.stop &&
    value.returnPercent >= -m.rules.contractLossPercent - 1e-10
  );
}
export function contractionRatio(data: Dataset, cutoff: number): number | undefined {
  const recent = completed(data.intraday, cutoff).slice(-4);
  if (recent.length !== 4) return undefined;
  const ratios: number[] = [];
  for (const bar of recent) {
    const samples = baselineSamples(data, '15m', bar, 10);
    const baseline = samples && mean(samples.map((b) => b.high - b.low));
    if (!baseline || baseline <= 0) return undefined;
    ratios.push((bar.high - bar.low) / baseline);
  }
  return mean(ratios);
}
export function parseContract(value: string) {
  const contract = value.trim().toUpperCase();
  const match = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(contract);
  if (!match)
    throw new Error(
      'Use a standard equity/ETF OCC call or put symbol; adjusted contracts and spreads are unsupported.',
    );
  const expiry = `20${match[2]}-${match[3]}-${match[4]}`;
  const date = Date.parse(`${expiry}T00:00:00Z`);
  if (
    !Number.isFinite(date) ||
    new Date(date).toISOString().slice(0, 10) !== expiry ||
    Number(match[6]) <= 0
  )
    throw new Error('Invalid contract expiry or strike.');
  return {
    contract,
    symbol: match[1]!,
    expiry,
    direction: match[5] === 'C' ? ('bullish' as const) : ('bearish' as const),
  };
}
