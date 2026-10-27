import type { Bar, Direction } from '../domain.js';

export const executionCosts = { slippageBps: 10, feeBps: 5 } as const;
export interface Execution {
  status: 'open' | 'closed' | 'skipped' | 'unavailable';
  reason: string;
  entry?: number;
  entryAt?: number;
  risk?: number;
  exit?: number;
  exitAt?: number;
  ambiguous?: boolean;
  netPerUnit?: number;
  rMultiple?: number;
}
export function beginExecution(
  bar: Bar,
  direction: Direction,
  level: number,
  target: number | undefined,
  costs = executionCosts as { slippageBps: number; feeBps: number },
): Execution {
  const sign = direction === 'bullish' ? 1 : -1;
  const entry = bar.open * (1 + (sign * costs.slippageBps) / 10000);
  const risk = sign * (entry - level);
  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(risk) ||
    risk <= 0 ||
    target === undefined ||
    !Number.isFinite(target) ||
    sign * (target - entry) <= 0
  )
    return { status: 'skipped', reason: 'Next-bar gap invalidates entry geometry' };
  return { status: 'open', reason: 'No observed exit', entry, entryAt: bar.start, risk };
}
/** Shared OHLC execution convention; never used to place orders or change signal lifecycles. */
export function stepExecution(
  state: Execution,
  bar: Bar,
  direction: Direction,
  level: number,
  target: number,
  timeExit?: number,
  costs = executionCosts as { slippageBps: number; feeBps: number },
): Execution {
  if (state.status !== 'open') return state;
  const sign = direction === 'bullish' ? 1 : -1;
  const gap = sign * (bar.open - level) <= 0;
  const stopped = sign === 1 ? bar.low <= level : bar.high >= level;
  const targeted = sign === 1 ? bar.high >= target : bar.low <= target;
  let exit: number, reason: string;
  if (timeExit !== undefined && bar.start >= timeExit) {
    exit = bar.open;
    reason = 'Time exit at next-bar open';
  } else if (gap || stopped) {
    exit = gap ? bar.open : level;
    reason = gap ? 'Gap through stop' : 'Stop touched';
  } else if (targeted) {
    exit = target;
    reason = 'Final target touched';
  } else return state;
  const executedExit = exit * (1 - (sign * costs.slippageBps) / 10000);
  const fees = ((state.entry! + executedExit) * costs.feeBps) / 10000;
  const net = sign * (executedExit - state.entry!) - fees;
  return {
    ...state,
    status: 'closed',
    reason,
    exit: executedExit,
    exitAt: bar.start,
    ambiguous: timeExit !== undefined && bar.start >= timeExit ? false : stopped && targeted,
    netPerUnit: net,
    rMultiple: net / state.risk!,
  };
}
