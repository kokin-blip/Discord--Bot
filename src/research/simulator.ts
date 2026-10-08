import type { Dataset, SignalEvent } from '../domain.js';
import { validateBars } from '../core/time.js';
export interface SimulationCosts {
  slippageBps: number;
  feeBps: number;
  holdoutFraction: number;
}
export interface SimulatedTrade {
  ideaId: string;
  symbol: string;
  version: string;
  status: string;
  reason: string;
  sample?: string;
  entry?: number;
  entryAt?: number;
  exit?: number;
  exitAt?: number;
  ambiguous?: boolean;
  netPerUnit?: number;
  rMultiple?: number;
}
export const simulationDefaults: SimulationCosts = {
  slippageBps: 10,
  feeBps: 5,
  holdoutFraction: 0.2,
};
/** Offline one-unit model: next completed-bar open, physical stop, final target, no live orders. */
export function simulate(
  datasets: Dataset[],
  events: SignalEvent[],
  costs: SimulationCosts = simulationDefaults,
) {
  if (
    ![costs.slippageBps, costs.feeBps, costs.holdoutFraction].every(Number.isFinite) ||
    costs.slippageBps < 0 ||
    costs.slippageBps > 1000 ||
    costs.feeBps < 0 ||
    costs.feeBps > 1000 ||
    costs.holdoutFraction <= 0 ||
    costs.holdoutFraction >= 1
  )
    throw new Error('Invalid simulator costs or holdout');
  const allBars = datasets.flatMap((d) => d.intraday);
  if (!allBars.length) throw new Error('Simulation requires intraday bars');
  for (const d of datasets) validateBars(d.intraday);
  const start = Math.min(...allBars.map((b) => b.start)),
    end = Math.max(...allBars.map((b) => b.end));
  const holdoutAt = start + (end - start) * (1 - costs.holdoutFraction);
  const trades = events
    .filter((e) => e.state === 'entry_triggered' && !e.recovery)
    .map((e): SimulatedTrade => {
      const data = datasets.find((d) => d.instrument.id === e.instrument.id);
      const bars = data?.intraday.filter((b) => b.start >= e.marketTime) ?? [];
      const first = bars[0];
      const s = e.direction === 'bullish' ? 1 : -1;
      const base = { ideaId: e.ideaId, symbol: e.instrument.symbol, version: e.strategyVersion };
      if (!first)
        return {
          ...base,
          status: 'unknown',
          reason: 'No next bar for execution',
          sample: 'unassigned',
        };
      const entry = first.open * (1 + (s * costs.slippageBps) / 10000);
      const risk = s * (entry - e.candidate.level);
      const target = e.candidate.target;
      const sample = first.start >= holdoutAt ? 'holdout' : 'development';
      if (risk <= 0 || target === undefined || s * (target - entry) <= 0)
        return {
          ...base,
          status: 'skipped',
          reason: 'Next-bar gap invalidates entry geometry',
          sample,
        };
      const timeExit = events
        .filter(
          (x) => x.ideaId === e.ideaId && x.state === 'time_exit' && x.marketTime >= e.marketTime,
        )
        .sort((a, b) => a.marketTime - b.marketTime)[0];
      let exit: number | undefined,
        exitAt: number | undefined,
        reason = 'No observed exit',
        ambiguous = false;
      for (const b of bars) {
        const stop = s * (b.open - e.candidate.level) <= 0;
        const stopTouched = s === 1 ? b.low <= e.candidate.level : b.high >= e.candidate.level;
        const targetTouched = s === 1 ? b.high >= target : b.low <= target;
        if (timeExit && b.start >= timeExit.marketTime) {
          exit = b.open;
          reason = 'Time exit at next-bar open';
        } else if (stop || stopTouched) {
          exit = stop ? b.open : e.candidate.level;
          reason = stop ? 'Gap through stop' : 'Stop touched';
          ambiguous = stopTouched && targetTouched;
        } else if (targetTouched) {
          exit = target;
          reason = 'Final target touched';
        } else if (timeExit && b.start >= timeExit.marketTime) {
          exit = b.open;
          reason = 'Time exit at next-bar open';
        }
        if (exit !== undefined) {
          exitAt = b.start;
          break;
        }
      }
      if (exit === undefined)
        return { ...base, status: 'unknown', reason, entry, entryAt: first.start, sample };
      const executedExit = exit * (1 - (s * costs.slippageBps) / 10000);
      const fees = ((entry + executedExit) * costs.feeBps) / 10000;
      const net = s * (executedExit - entry) - fees;
      return {
        ...base,
        status: 'closed',
        entry,
        entryAt: first.start,
        exit: executedExit,
        exitAt,
        reason,
        ambiguous,
        sample,
        netPerUnit: net,
        rMultiple: net / risk,
      };
    });
  const summary = (sample: string) => {
    const rows = trades.filter((t) => t.sample === sample);
    const closed = rows.filter((t) => t.status === 'closed');
    return {
      sample,
      total: rows.length,
      closed: closed.length,
      unknown: rows.filter((t) => t.status === 'unknown').length,
      skipped: rows.filter((t) => t.status === 'skipped').length,
      ambiguous: closed.filter((t) => t.ambiguous).length,
      meanR: closed.length
        ? closed.reduce((a, t) => a + (t.rMultiple ?? 0), 0) / closed.length
        : null,
    };
  };
  return {
    costs,
    holdoutAt: new Date(holdoutAt).toISOString(),
    summary: ['development', 'holdout', 'unassigned'].map(summary),
    trades,
    assumptions:
      'One unit per signal; entry at next-bar open with adverse slippage; physical stop and final-target exits; stop wins ambiguous OHLC bars; gaps through stop execute at open; time exits at next-bar open; fees on both sides. No portfolio sizing, liquidity model, partial targets or borrow costs. Chronological holdout is descriptive; no tuning is performed. Missing future bars remain unknown. This research model is separate from close-based public invalidation and is not proof of profitability.',
  };
}
