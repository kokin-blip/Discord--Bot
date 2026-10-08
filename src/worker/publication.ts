import type { Store } from '../sql-store.js';
import type { SignalEvent } from '../domain.js';
import { strategyVersion } from '../core/strategy.js';
import { currentReversal } from '../reversal-config.js';

export function publicationVersion(store: Store): string {
  return `${strategyVersion(store.strategy())}:${currentReversal(store).version}`;
}
export function productionBlockers(store: Store, now: number): string[] {
  const issues: string[] = [];
  const soak = store.get('soak_start', 0);
  if (!soak || now - soak < 7 * 86_400_000 || now - store.get('healthy_at', 0) > 600_000)
    issues.push('SEVEN_DAY_SOAK_REQUIRED');
  if (!store.get('historical_replay_verified', false)) issues.push('HISTORICAL_REPLAY_REQUIRED');
  return issues;
}
/** A new version's review cannot interrupt updates to an already published production call. */
export function canPublishProduction(store: Store, event: SignalEvent, ready: boolean): boolean {
  if (ready) return true;
  return (
    event.strategyVersion.startsWith('br-v1-') &&
    store.get(`production_idea:${event.ideaId}`, '') === event.strategyVersion
  );
}
