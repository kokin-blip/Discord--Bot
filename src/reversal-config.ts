import type { Store } from './sql-store.js';
import { stableId } from './core/strategy.js';
export interface ReversalConfig {
  benchmarkAgreement: boolean;
  confirmationBars: number;
}
export const reversalDefaults: ReversalConfig = { benchmarkAgreement: false, confirmationBars: 5 };
export const reversalVersion = (config: ReversalConfig) =>
  `reversal-v1-${stableId(config.benchmarkAgreement, config.confirmationBars)}`;
export function saveReversal(store: Store, config: ReversalConfig): string {
  if (typeof config.benchmarkAgreement !== 'boolean' || config.confirmationBars !== 5)
    throw new Error('INVALID_REVERSAL_CONFIG');
  const version = reversalVersion(config);
  store.transaction(() => {
    const previous = store.get('reversal_version', reversalVersion(reversalDefaults));
    store.db
      .prepare('INSERT OR IGNORE INTO reversal_versions VALUES(?,?)')
      .run(version, JSON.stringify(config));
    store.set('reversal_version', version);
    if (previous !== version) {
      store.set('historical_replay_verified', false);
      store.set('soak_start', 0);
    }
  });
  return version;
}
export function currentReversal(store: Store): { version: string; config: ReversalConfig } {
  const version = store.get('reversal_version', reversalVersion(reversalDefaults));
  const row = store.db
    .prepare('SELECT body FROM reversal_versions WHERE version=?')
    .get(version) as { body: string } | undefined;
  return { version, config: row ? JSON.parse(row.body) : reversalDefaults };
}
