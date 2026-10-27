import type { Store } from '../sql-store.js';
import type { SignalEvent } from '../domain.js';
import { strategyVersion } from '../core/strategy.js';
import { currentReversal } from '../reversal-config.js';

export function publicationVersion(store: Store): string {
  return `${strategyVersion(store.strategy())}:${currentReversal(store).version}`;
}
export function productionBlockers(store: Store, now: number): string[] {
  // Live publication uses channel permissions, pause, quotas and data-quality checks.
  return [];
}
/** A new version's review cannot interrupt updates to an already published production call. */
export function canPublishProduction(store: Store, event: SignalEvent, ready: boolean): boolean {
  if (ready) return true;
  return (
    event.strategyVersion.startsWith('br-v1-') &&
    store.get(`production_idea:${event.ideaId}`, '') === event.strategyVersion
  );
}
