import { configuredChannels, reviewedNews } from './live-fixtures.js';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { DurableObjectState, DurableObjectStorage } from '@cloudflare/workers-types';
import { SignalCoordinator } from '../src/worker/coordinator.js';
import type { Env } from '../src/worker/types.js';
import { routes } from '../src/config.js';
import { currentRelease } from '../src/releases.js';
import { ThresholdStore } from '../src/threshold/store.js';
import { mature, open, thresholdFixture } from './threshold-fixtures.js';
afterEach(() => vi.restoreAllMocks());
function coordinator(mode: 'test' | 'production') {
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
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  const c = new SignalCoordinator(
    { storage } as DurableObjectState,
    {
      FREE_PLAN_CONFIRMED: 'true',
      DISCORD_TOKEN: 'synthetic-token',
      DISCORD_GUILD_ID: '123',
      DISCORD_APPLICATION_ID: '456',
      ALPACA_API_KEY: 'synthetic-key',
      ALPACA_API_SECRET: 'synthetic-secret',
      TEST_CHANNEL_ID: '789',
      RELEASE_MODE: mode,
    } as Env,
  );
  vi.spyOn(c.client.rest, 'get').mockResolvedValue({
    id: '123',
    username: 'test',
    discriminator: '0',
    avatar: null,
    bot: true,
  });
  vi.spyOn(c.client.rest, 'put').mockResolvedValue([]);
  vi.spyOn(c.client.guilds, 'fetch').mockResolvedValue({} as never);
  vi.spyOn(c.service, 'scan').mockResolvedValue();
  vi.spyOn(c.publisher, 'validate').mockResolvedValue({} as never);
  vi.spyOn(c.newsIngestion!, 'tick').mockResolvedValue({ status: 'idle', diagnostic: null });
  c.store.set(`release_queued:${currentRelease.id}`, true);
  c.store.set('historical_replay_verified', true);
  c.store.set('soak_start', mature - 8 * 86400000);
  c.store.set('healthy_at', mature);
  const settings = c.store.settings();
  for (const route of routes) settings.channels[route] = `production-${route}`;
  c.store.set('settings', settings);
  configuredChannels(c, settings.channels);
  return { c, db };
}
it.each(['test', 'production'] as const)(
  'routes threshold prompts through the existing %s publication path',
  async (mode) => {
    vi.spyOn(Date, 'now').mockReturnValue(mature);
    const f = thresholdFixture(),
      { c, db } = coordinator(mode);
    try {
      f.add();
      await f.tick(open);
      await f.tick(mature);
      const event = f.pending()[0]!.event;
      c.store.enqueue(event, 'updates');
      const deliver = vi.spyOn(c.publisher, 'deliver').mockResolvedValue();
      const response = await c.fetch(new Request('https://internal/tick'));
      expect(response.status).toBe(200);
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ id: event.id, kind: 'threshold_alert' }),
        'production-updates',
      );
      expect(
        c.store.db.prepare('SELECT status FROM outbox WHERE event_id=?').get(event.id),
      ).toMatchObject({ status: 'delivered' });
    } finally {
      f.store.close();
      await c.client.destroy();
      db.close();
    }
  },
);
it('preserves threshold suppression after the publisher returns without a Discord send', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(mature);
  const f = thresholdFixture(),
    { c, db } = coordinator('test');
  try {
    f.add();
    await f.tick(open);
    await f.tick(mature);
    const event = f.pending()[0]!.event;
    c.store.enqueue(event, 'updates');
    vi.spyOn(c.publisher, 'deliver').mockImplementation(async (e) => {
      new ThresholdStore(c.store).suppress(e);
    });
    expect((await c.fetch(new Request('https://internal/tick'))).status).toBe(200);
    expect(
      c.store.db.prepare('SELECT status FROM outbox WHERE event_id=?').get(event.id),
    ).toMatchObject({ status: 'suppressed' });
    expect(c.store.receipt(event.id, '789')).toBeUndefined();
  } finally {
    f.store.close();
    await c.client.destroy();
    db.close();
  }
});
