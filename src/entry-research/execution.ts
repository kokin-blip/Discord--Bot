import type { Bar, Market, SignalEvent } from '../domain.js';
import { beginExecution, stepExecution, type Execution } from '../research/execution.js';

export interface EntryCosts {
  slippageBps: number;
  feeBps: number;
}
export interface EntryAssumptions {
  schema: 'execution-v2';
  pollMs: number;
  deliveryMs: number;
  responseMs: number;
  costs: Record<Market, EntryCosts>;
  resolutionMs: number;
}
export const entryAssumptions: EntryAssumptions = {
  schema: 'execution-v2',
  pollMs: 300_000,
  deliveryMs: 60_000,
  responseMs: 60_000,
  costs: { equity: { slippageBps: 10, feeBps: 5 }, crypto: { slippageBps: 10, feeBps: 60 } },
  resolutionMs: 900_000,
};
export interface ObservedTiming {
  sourceObservedAt?: number;
  detectedAt?: number;
  deliveredAt?: number;
}
export interface EconomicCase {
  name: string;
  availableAt: number;
  costs: EntryCosts;
  execution?: Execution;
}
export interface EntryEconomics {
  schema: 'execution-v2';
  availability: 'observed' | 'mixed' | 'modeled';
  assumptions: EntryAssumptions;
  cases: EconomicCase[];
  lastBar: number;
  incomplete?: string;
  conditionalShort: boolean;
}
export function availableAt(
  event: SignalEvent,
  assumptions: EntryAssumptions,
  timing: ObservedTiming = {},
) {
  const source =
    timing.sourceObservedAt ?? event.marketTime + event.provenance.delayMinutes * 60_000;
  const detected = Math.max(
    source,
    timing.detectedAt ?? Math.ceil(source / assumptions.pollMs) * assumptions.pollMs,
  );
  return (
    Math.max(event.marketTime, timing.deliveredAt ?? detected + assumptions.deliveryMs) +
    assumptions.responseMs
  );
}
export function beginEconomics(
  event: SignalEvent,
  timing: ObservedTiming = {},
  assumptions: EntryAssumptions = entryAssumptions,
): EntryEconomics {
  const frozen = structuredClone(assumptions),
    cases: EconomicCase[] = [];
  for (const response of ['normal', 'zero_delay', 'slow_response'] as const) {
    const a = {
      ...frozen,
      deliveryMs: response === 'zero_delay' ? 0 : frozen.deliveryMs,
      responseMs:
        response === 'zero_delay' ? 0 : response === 'slow_response' ? 180_000 : frozen.responseMs,
    };
    for (const friction of [1, 2, 3])
      cases.push({
        name: `${response}:cost${friction}`,
        availableAt: availableAt(event, a, timing),
        costs: {
          slippageBps: frozen.costs[event.instrument.market].slippageBps * friction,
          feeBps: frozen.costs[event.instrument.market].feeBps * friction,
        },
      });
  }
  return {
    schema: 'execution-v2',
    availability:
      timing.deliveredAt !== undefined && timing.sourceObservedAt !== undefined
        ? 'observed'
        : Object.values(timing).some((v) => v !== undefined)
          ? 'mixed'
          : 'modeled',
    assumptions: frozen,
    cases,
    lastBar: event.marketTime,
    conditionalShort: event.direction === 'bearish',
  };
}
export function stepEconomics(
  model: EntryEconomics,
  event: SignalEvent,
  bar: Bar,
  timeExit?: number,
  terminalAt?: number,
) {
  if (bar.end <= model.lastBar) return;
  if (bar.start < event.marketTime) return;
  // Callers validate continuity against the market calendar, including overnight closures.
  for (const scenario of model.cases) {
    if (bar.start < scenario.availableAt) continue;
    if (!scenario.execution) {
      if (terminalAt !== undefined && terminalAt <= bar.start) {
        scenario.execution = {
          status: 'skipped',
          reason: 'Signal already terminal before an available execution bar',
        };
        continue;
      }
      scenario.execution = beginExecution(
        bar,
        event.direction,
        event.candidate.level,
        event.candidate.target,
        scenario.costs,
      );
    }
    scenario.execution = stepExecution(
      scenario.execution,
      bar,
      event.direction,
      event.candidate.level,
      event.candidate.target!,
      timeExit,
      scenario.costs,
    );
  }
  model.lastBar = bar.end;
}
export function finishEconomics(model: EntryEconomics, reason?: string) {
  for (const c of model.cases)
    if (!c.execution || c.execution.status === 'open')
      c.execution = {
        ...c.execution,
        status: 'unavailable',
        reason: reason ?? 'No observed execution exit within covered history',
      };
  if (reason) model.incomplete ??= reason;
  return model;
}
export function netR(
  model: EntryEconomics | undefined,
  scenario = 'normal:cost1',
): number | undefined {
  if (!model || model.incomplete) return;
  const e = model.cases.find((c) => c.name === scenario)?.execution;
  return e?.status === 'closed' ? e.rMultiple : e?.status === 'skipped' ? 0 : undefined;
}
