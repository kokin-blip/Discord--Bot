import type { SignalEvent } from './domain.js';

export type CalloutFamily = 'strategy_entry' | 'strategy_setup' | 'reversal_warning';
export type CalloutOutcome = 'success' | 'failure' | 'unconfirmed' | 'ambiguous' | 'unknown';

/** Shared with learning: these are signal-reference outcomes, never simulated fills. */
export function calloutOutcome(e: SignalEvent): CalloutOutcome | undefined {
  if (e.tracker?.type === 'reversal')
    return e.tracker.phase === 'cancelled'
      ? 'failure'
      : e.tracker.phase === 'confirmed'
        ? 'success'
        : e.tracker.phase === 'expired'
          ? 'unconfirmed'
          : undefined;
  if (e.performance?.ambiguous || e.observations?.length)
    return ['invalidated', 'final_target', 'time_exit'].includes(e.state) ? 'ambiguous' : undefined;
  if (e.state === 'invalidated') return 'failure';
  if (e.state === 'final_target' || e.state === 'entry_triggered') return 'success';
  if (e.state === 'expired') return 'unconfirmed';
  if (e.state === 'time_exit')
    return e.performance === undefined || !Number.isFinite(e.performance.changePercent)
      ? 'unknown'
      : e.performance.changePercent < 0
        ? 'failure'
        : 'success';
  return undefined;
}
