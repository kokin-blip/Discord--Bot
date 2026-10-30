import type { Store } from '../sql-store.js';
import { repairReport } from '../history-repair.js';
import { timingReport } from './timing.js';

/** Three private aggregate snapshots per deployed version; never publish diagnostic data. */
export function entryRuntimeSnapshot(store: Store, version: string | undefined, now: number) {
  if (!version) return;
  const previous = store.get('entry_runtime_logs', { version: '', count: 0 });
  const count = previous.version === version ? previous.count : 0;
  if (count >= 3) return;
  try {
    const repairs = repairReport(store);
    const work = store.db
      .prepare(
        "SELECT COUNT(*) AS instruments,MIN(json_extract(body,'$.through')) AS earliestThrough,MAX(json_extract(body,'$.through')) AS latestThrough FROM entry_research_work",
      )
      .get();
    const snapshot = {
      schema: 'entry-runtime-v1',
      version,
      at: now,
      cohort: store.get('entry_research_cohort', null),
      work,
      progress: store.get('entry_research_progress', null),
      repairs: {
        pending: repairs.pending,
        unavailable: repairs.unavailable,
        jobs: repairs.jobs.length,
        attempts: repairs.jobs.reduce((s, j) => s + j.attempts, 0),
        lastUpdated: Math.max(0, ...repairs.jobs.map((j) => j.updatedAt)),
      },
      timing: timingReport(store),
      registration: {
        version: store.get('command_registration', null),
        details: store.get('command_registration_details', null),
        error: store.get('command_registration_error', null),
      },
      lastScan: store.get('last_scan', 0),
      channelSetup: store.get('channel_setup_status', null),
      researchError: store.get('entry_research_error', null),
      repairError: store.get('history_repair_error', null),
    };
    store.set('entry_runtime_logs', { version, count: count + 1 });
    return snapshot;
  } catch {
    /* Optional private telemetry cannot interrupt publication. */
  }
}
