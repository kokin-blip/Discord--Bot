/** Offline schema/upgrade check against the bundled Worker in real local workerd SQLite. */
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve('output/worker');
const persistence = mkdtempSync(resolve(tmpdir(), 'entry-workerd-'));
const createRuntime = () =>
  new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: persistence,
      name: 'entry-local-schema',
      unsafeInspectDurableObjects: true,
      modules: [
        {
          type: 'ESModule',
          path: resolve(root, 'entry-smoke-entry.js'),
          // Local inspection requires RPC; delegate initialization/read behavior to the actual bundle.
          contents: `import { DurableObject } from 'cloudflare:workers';
          import worker, { SignalCoordinator } from './index.js';
          export class EntrySmoke extends DurableObject {
            constructor(ctx, env) { super(ctx, env); this.coordinator = new SignalCoordinator(ctx, env); }
            fetch(request) { return this.coordinator.fetch(request); }
          }
          export default worker;`,
        },
        { type: 'ESModule', path: resolve(root, 'index.js') },
        ...readdirSync(root)
          .filter((f) => f.endsWith('.txt'))
          .map((f) => ({ type: 'Text' as const, path: resolve(root, f) })),
      ],
      compatibilityDate: '2026-10-04',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { SIGNALS: { className: 'EntrySmoke', useSQLite: true } },
      bindings: {
        DISCORD_GUILD_ID: 'offline-guild',
      },
      outboundService: async () => {
        throw new Error('Unexpected outbound request during offline schema check');
      },
    }),
  );
let mf = createRuntime();
try {
  const ns = await mf.getDurableObjectNamespace('SIGNALS');
  const stub = ns.get(ns.idFromName('offline-schema'));
  const request = () =>
    stub.fetch('https://internal/autocomplete', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          name: 'entry',
          options: [{ name: 'entries', options: [] }],
        },
      }),
    });
  const response = await request();
  if (!response.ok)
    throw new Error(`Schema initialization failed: ${response.status} ${await response.text()}`);
  const sql = await mf.unsafeGetDurableObjectStorage('entry-local-schema', 'EntrySmoke', {
    name: 'offline-schema',
  });
  const tables = await sql.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('history_repairs','source_observations','entry_timings','delivery_timings','entry_enrichment','entry_cohorts','entry_research_work','entry_opportunities','entry_positions','entry_results','learning_measurements_v2','learning_execution_work_v2') ORDER BY name",
  );
  if (tables.length !== 12) throw new Error('Entry reliability/research tables missing');
  await sql.exec('INSERT INTO entry_cohorts VALUES(?,?,?)', 'synthetic-cohort', 1, '{}');
  let immutable = false;
  try {
    await sql.exec(
      'UPDATE entry_cohorts SET body=? WHERE id=?',
      '{"changed":true}',
      'synthetic-cohort',
    );
  } catch {
    immutable = true;
  }
  if (!immutable) throw new Error('Rule immutability trigger failed');
  await mf.dispose();
  mf = createRuntime();
  const restarted = await mf.getDurableObjectNamespace('SIGNALS');
  const reopened = await restarted
    .get(restarted.idFromName('offline-schema'))
    .fetch('https://internal/autocomplete', {
      method: 'POST',
      body: JSON.stringify({ data: { name: 'entry', options: [] } }),
    });
  if (!reopened.ok) throw new Error('Restarted schema initialization failed');
  const reopenedStorage = await mf.unsafeGetDurableObjectStorage(
    'entry-local-schema',
    'EntrySmoke',
    { name: 'offline-schema' },
  );
  const retained = await reopenedStorage.exec(
    'SELECT body FROM entry_cohorts WHERE id=?',
    'synthetic-cohort',
  );
  if (retained[0]?.body !== '{}') throw new Error('Rule did not survive local workerd restart');
  console.log(
    JSON.stringify({
      runtime: 'local workerd SQLite',
      tables,
      immutable,
      restart: true,
      externalRequests: 0,
    }),
  );
} finally {
  await mf.dispose();
  rmSync(persistence, { recursive: true, force: true });
}
