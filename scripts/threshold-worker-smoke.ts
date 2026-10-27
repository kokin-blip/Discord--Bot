/** Offline schema/upgrade check against the bundled Worker in real local workerd SQLite. */
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve('output/worker');
const persistence = mkdtempSync(resolve(tmpdir(), 'threshold-workerd-'));
const createRuntime = () =>
  new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: persistence,
      name: 'threshold-local-schema',
      unsafeInspectDurableObjects: true,
      modules: [
        {
          type: 'ESModule',
          path: resolve(root, 'threshold-smoke-entry.js'),
          // Local inspection requires RPC; delegate initialization/read behavior to the actual bundle.
          contents: `import { DurableObject } from 'cloudflare:workers';
          import worker, { SignalCoordinator } from './index.js';
          export class ThresholdSmoke extends DurableObject {
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
      durableObjects: { SIGNALS: { className: 'ThresholdSmoke', useSQLite: true } },
      bindings: {
        DISCORD_GUILD_ID: 'offline-guild',
        RELEASE_MODE: 'test',
        TEST_CHANNEL_ID: 'offline-private',
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
          name: 'threshold',
          options: [{ name: 'show', options: [{ name: 'id', value: '', focused: true }] }],
        },
      }),
    });
  const response = await request();
  if (!response.ok)
    throw new Error(`Schema initialization failed: ${response.status} ${await response.text()}`);
  const sql = await mf.unsafeGetDurableObjectStorage('threshold-local-schema', 'ThresholdSmoke', {
    name: 'offline-schema',
  });
  const tables = await sql.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'threshold_%' ORDER BY name",
  );
  if (tables.length !== 4) throw new Error('Threshold tables missing');
  await sql.exec('INSERT INTO threshold_rules VALUES(?,?)', 'synthetic-rule', '{}');
  let immutable = false;
  try {
    await sql.exec(
      'UPDATE threshold_rules SET body=? WHERE id=?',
      '{"changed":true}',
      'synthetic-rule',
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
      body: JSON.stringify({ data: { name: 'threshold', options: [] } }),
    });
  if (!reopened.ok) throw new Error('Restarted schema initialization failed');
  const reopenedStorage = await mf.unsafeGetDurableObjectStorage(
    'threshold-local-schema',
    'ThresholdSmoke',
    { name: 'offline-schema' },
  );
  const retained = await reopenedStorage.exec(
    'SELECT body FROM threshold_rules WHERE id=?',
    'synthetic-rule',
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
