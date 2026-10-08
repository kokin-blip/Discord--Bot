import type { SignalEvent } from '../domain.js';
import type { Store } from '../sql-store.js';
import { terminalStates } from '../domain.js';

export function deliveryContext(store: Store, event: SignalEvent, now: number): string | undefined {
  if (
    !event.strategyVersion.startsWith('br-v1-') ||
    !['watching', 'setup_ready', 'entry_triggered'].includes(event.state)
  )
    return undefined;
  const latest = store.idea(event.ideaId);
  if (latest && terminalStates.has(latest.state))
    return `Historical update: this idea is now ${latest.state}. This message is not an actionable entry.`;
  if (now - event.marketTime > 45 * 60_000 && event.state === 'entry_triggered')
    return 'Historical entry reference: delivery is more than 45 minutes after confirmation. Do not treat this as a current entry signal.';
  if (latest?.candidate.entry !== undefined && event.state !== 'entry_triggered')
    return 'Historical setup update: this idea has already confirmed. Inspect the latest idea state.';
  return undefined;
}
