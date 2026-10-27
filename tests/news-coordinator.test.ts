import { configuredChannels, reviewedNews } from './live-fixtures.js';
import { NewsMonitor } from '../src/news/monitor.js';
import { announcement } from '../src/announcements.js';
import { currentRelease } from '../src/releases.js';
import { equity } from '../src/domain.js';
import { observation, policy, now } from './news-fixtures.js';
import { expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { DurableObjectState, DurableObjectStorage } from '@cloudflare/workers-types';
import { SignalCoordinator } from '../src/worker/coordinator.js';
import type { Env } from '../src/worker/types.js';
function coordinatorFixture(mode: 'test' | 'production' = 'test') {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: {
      databaseSize: 0,
      exec(sql: string, ...params: (string | number | null)[]) {
        let rows: unknown[] = [];
        if (params.length || /^\s*(SELECT|PRAGMA)/i.test(sql))
          rows = db.prepare(sql).all(...params);
        else db.exec(sql);
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
  const coordinator = new SignalCoordinator(
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
  configuredChannels(coordinator);
  return { coordinator, db };
}
it('runs news after scans and durable deliveries and isolates unexpected news failures', async () => {
  const { coordinator, db } = coordinatorFixture();
  const order: string[] = [],
    soak = Date.now() - 7 * 86400000;
  try {
    coordinator.store.set('soak_start', soak);
    vi.spyOn(coordinator.client.rest, 'get').mockResolvedValue({
      id: '123',
      username: 'test',
      discriminator: '0',
      avatar: null,
      bot: true,
    });
    vi.spyOn(coordinator.client.rest, 'put').mockResolvedValue([]);
    vi.spyOn(coordinator.client.guilds, 'fetch').mockResolvedValue({} as never);
    vi.spyOn(coordinator.service, 'scan').mockImplementation(async () => {
      order.push('scan');
    });
    vi.spyOn(coordinator.publisher, 'validate').mockResolvedValue({} as never);
    vi.spyOn(coordinator.publisher, 'deliver').mockImplementation(async () => {
      order.push('delivery');
    });
    vi.spyOn(coordinator.newsIngestion!, 'tick').mockImplementation(async () => {
      order.push('news');
      throw new Error('private-key');
    });
    const result = await coordinator.fetch(new Request('https://coordinator/tick'));
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('Tick complete');
    expect(order[0]).toBe('scan');
    expect(order).toContain('delivery');
    expect(order[order.length - 1]).toBe('news');
    expect(coordinator.store.get('soak_start', 0)).toBe(soak);
    expect(coordinator.store.get('last_error', 'missing')).toBeNull();
    expect(coordinator.store.get('news_runtime_error', '')).toBe('NEWS_RUNTIME_FAILED');
    expect(coordinator.store.pendingCount()).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await coordinator.client.destroy();
    db.close();
  }
});

function ready(coordinator: SignalCoordinator) {
  vi.spyOn(coordinator.client.rest, 'get').mockResolvedValue({
    id: '123',
    username: 'test',
    discriminator: '0',
    avatar: null,
    bot: true,
  });
  vi.spyOn(coordinator.client.rest, 'put').mockResolvedValue([]);
  vi.spyOn(coordinator.client.guilds, 'fetch').mockResolvedValue({} as never);
  vi.spyOn(coordinator.service, 'scan').mockResolvedValue();
  vi.spyOn(coordinator.publisher, 'validate').mockResolvedValue({} as never);
  vi.spyOn(coordinator.newsIngestion!, 'tick').mockResolvedValue({
    status: 'idle',
    diagnostic: null,
  });
}
function licensedAlert(coordinator: SignalCoordinator) {
  const news = coordinator.news!,
    instrument = equity('TEST');
  news.saveConfig({ enabled: true, alerts: true, providers: { marketaux: true } });
  coordinator.store.pin(instrument);
  coordinator.store.db.exec("UPDATE outbox SET status='delivered'");
  coordinator.store.set(`release_queued:${currentRelease.id}`, true);
  for (const scope of ['provider', 'publisher'] as const) {
    const p = policy(scope);
    news.savePolicy({
      ...p,
      permissions: {
        ...p.permissions,
        retainHeadline: true,
        analyze: true,
        retainDerived: true,
        publishMetadata: true,
        publishDerived: true,
      },
    });
  }
  news.saveAlias({
    id: 'issuer',
    instrumentId: instrument.id,
    alias: 'Test Company',
    venue: 'NASDAQ',
    reviewedAt: now - 1,
    expiresAt: now + 86400000,
    evidence: 'Synthetic issuer review',
  });
  news.savePublisherGroup({
    domain: 'publisher.example',
    groupId: 'issuer',
    reviewedAt: now - 1,
    expiresAt: now + 86400000,
    evidence: 'Synthetic topic review',
    firstParty: true,
    firstPartyTopics: [`instrument:${instrument.id}`],
  });
  news.saveObservation(
    observation({ headline: 'Test Company filed for bankruptcy', description: null }),
    now,
  );
  coordinator.newsIngestion!.intelligence.process(now);
  reviewedNews(news, now);
  coordinator.newsIngestion!.monitor.success('marketaux', now, 'live');
  coordinator.newsPublication!.queue(now);
}
it('preserves three existing delivery slots and sends at most one news event using spare capacity', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const { coordinator, db } = coordinatorFixture();
  try {
    ready(coordinator);
    licensedAlert(coordinator);
    for (let i = 0; i < 3; i++)
      coordinator.store.enqueue(
        announcement(`existing-${i}`, 'Existing event', 'Synthetic operational text', now),
        'operations',
      );
    const delivered: { kind: string | undefined; target: string }[] = [];
    vi.spyOn(coordinator.publisher, 'deliver').mockImplementation(async (event, target) => {
      delivered.push({ kind: event.kind, target });
    });
    expect((await coordinator.fetch(new Request('https://coordinator/tick'))).status).toBe(200);
    expect(delivered).toHaveLength(3);
    expect(delivered.every((e) => e.kind === 'announcement')).toBe(true);
    expect(coordinator.store.pending(now)).toHaveLength(1);
    await coordinator.fetch(new Request('https://coordinator/tick'));
    expect(delivered).toHaveLength(4);
    expect(delivered[3]).toEqual({ kind: 'news_report', target: 'public' });
    expect(coordinator.store.pending(now)).toEqual([]);
    await coordinator.fetch(new Request('https://coordinator/tick'));
    expect(delivered).toHaveLength(4);
  } finally {
    vi.restoreAllMocks();
    await coordinator.client.destroy();
    db.close();
  }
});
it('news delivery failure retries independently without resetting market soak or error state', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const { coordinator, db } = coordinatorFixture();
  try {
    ready(coordinator);
    licensedAlert(coordinator);
    const soak = now - 8 * 86400000;
    coordinator.store.set('soak_start', soak);
    const deliver = vi
      .spyOn(coordinator.publisher, 'deliver')
      .mockRejectedValueOnce(new Error('synthetic secret failure'))
      .mockResolvedValue();
    await coordinator.fetch(new Request('https://coordinator/tick'));
    expect(coordinator.store.get('soak_start', 0)).toBe(soak);
    expect(coordinator.store.get('last_error', 'missing')).toBeNull();
    expect(coordinator.store.get('news_publication_error', '')).toBe('NEWS_DELIVERY_FAILED');
    expect(coordinator.store.pending(now + 31000)[0]?.attempts).toBe(1);
    clock.mockReturnValue(now + 31000);
    await coordinator.fetch(new Request('https://coordinator/tick'));
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(coordinator.store.pending(now + 31000)).toEqual([]);
    expect(coordinator.store.get('news_publication_error', 'missing')).toBeNull();
  } finally {
    vi.restoreAllMocks();
    await coordinator.client.destroy();
    db.close();
  }
});

it('publishes live without market soak or historical-attestation flags while retaining news review', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const { coordinator, db } = coordinatorFixture('production');
  try {
    ready(coordinator);
    licensedAlert(coordinator);
    expect(coordinator.store.get('historical_replay_verified', false)).toBe(false);
    expect(coordinator.newsPublication!.blockers(now)).toEqual([]);
    const deliver = vi.spyOn(coordinator.publisher, 'deliver').mockResolvedValue();
    await coordinator.fetch(new Request('https://coordinator/tick'));
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'news_report' }),
      'public',
    );
    expect(coordinator.store.get('publication_blockers', [])).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await coordinator.client.destroy();
    db.close();
  }
});
