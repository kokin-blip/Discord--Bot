import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { DurableObjectState, DurableObjectStorage } from '@cloudflare/workers-types';
import { SignalCoordinator } from '../src/worker/coordinator.js';
import type { Env } from '../src/worker/types.js';
import { routes } from '../src/config.js';
import { announcement } from '../src/announcements.js';
import { currentRelease } from '../src/releases.js';
import { Scorecard } from '../src/scorecard.js';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: {
      databaseSize: 0,
      exec(sql: string, ...params: (string | number | null)[]) {
        const rows =
          params.length || /^\s*(SELECT|PRAGMA)/i.test(sql)
            ? db.prepare(sql).all(...params)
            : (db.exec(sql), []);
        return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as DurableObjectStorage;
  // No legacy channel or release-mode variables, and no historical attestation or soak.
  const c = new SignalCoordinator(
    { storage } as DurableObjectState,
    {
      FREE_PLAN_CONFIRMED: 'true',
      DISCORD_GUILD_ID: 'guild',
      DISCORD_APPLICATION_ID: 'app',
      DISCORD_TOKEN: 'synthetic',
      ALPACA_API_KEY: 'synthetic',
      ALPACA_API_SECRET: 'synthetic',
    } as Env,
  );
  const inventory: any[] = [];
  let seq = 0;
  vi.spyOn(c.client.guilds, 'fetch').mockResolvedValue({} as never);
  vi.spyOn(c.client.rest, 'get').mockImplementation(async (route) =>
    route === '/users/@me'
      ? { id: 'bot', username: 'bot', discriminator: '0', avatar: null, bot: true }
      : structuredClone(inventory),
  );
  vi.spyOn(c.client.rest, 'put').mockResolvedValue([]);
  const create = vi.spyOn(c.client.rest, 'post').mockImplementation(async (_route, options) => {
    const channel = { ...(options?.body as object), id: `channel-${++seq}` };
    inventory.push(channel);
    return channel;
  });
  vi.spyOn(c.service, 'scan').mockResolvedValue();
  vi.spyOn(c.publisher, 'validate').mockResolvedValue({} as never);
  const deliver = vi
    .spyOn(c.publisher, 'deliver')
    .mockImplementation(async (event, destination) => {
      c.store.saveReceipt(event.id, destination, `message-${event.id}`);
    });
  return { c, db, inventory, create, deliver };
}
it('provisions live routes on scheduled ticks, registers scorecard, and publishes the release once', async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 4; n++) {
      const before = f.create.mock.calls.length;
      expect((await f.c.fetch(new Request('https://internal/tick'))).ok).toBe(true);
      expect(f.create.mock.calls.length - before).toBeLessThanOrEqual(2);
    }
    expect(f.inventory).toHaveLength(8);
    expect(routes.every((r) => !!f.c.store.settings().channels[r])).toBe(true);
    expect(f.c.store.get('channel_setup_status', {})).toMatchObject({ state: 'ready' });
    expect(f.c.store.get('command_registration_details', {})).toMatchObject({
      names: expect.arrayContaining(['scorecard']),
    });
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        announcement: expect.objectContaining({
          title: `Bot updated · ${currentRelease.title}`,
        }),
      }),
      f.c.store.settings().channels.operations,
    );
    await f.c.fetch(new Request('https://internal/tick'));
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(new Scorecard(f.c.store).summary().coverage.caughtUp).toBe(true);
  } finally {
    await f.c.client.destroy();
    f.db.close();
  }
});
it('does not copy receipted legacy messages after cutover and still honors pause', async () => {
  const f = fixture();
  try {
    f.c.store.set(`release_queued:${currentRelease.id}`, true);
    const legacy = announcement(
      'old-announcement',
      'Old update',
      'Already visible in legacy history',
      Date.now(),
    );
    f.c.store.enqueue(legacy, 'operations');
    f.c.store.saveReceipt(legacy.id, 'former-test-channel', 'legacy-message');
    const continuation = vi.spyOn(f.c.publisher, 'continueDiscussion').mockResolvedValue();
    for (let n = 0; n < 4; n++) await f.c.fetch(new Request('https://internal/tick'));
    expect(f.deliver).not.toHaveBeenCalled();
    expect(continuation).toHaveBeenCalledWith(legacy);
    expect(f.c.store.pendingCount()).toBe(0);
    expect(f.c.store.receipt(legacy.id, 'former-test-channel')).toBe('legacy-message');
    f.c.store.set('settings', { ...f.c.store.settings(), paused: true });
    f.c.store.enqueue(
      announcement('paused', 'Paused', 'Wait for resume', Date.now()),
      'operations',
    );
    await f.c.fetch(new Request('https://internal/tick'));
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.c.store.pendingCount()).toBe(1);
  } finally {
    await f.c.client.destroy();
    f.db.close();
  }
});
