import { expect, it } from 'vitest';
import { Store } from '../src/storage.js';
import { queueRelease } from '../src/announcements.js';
import { currentRelease } from '../src/releases.js';
import { crypto, equity } from '../src/domain.js';
import { fixture, idea } from './fixtures.js';
const updates = (store: Store) => store.journal().filter((e) => e.kind === 'announcement');
it('queues each major release once across repeated ticks and runtime changes', () => {
  const store = new Store(':memory:');
  try {
    queueRelease(store, 1, 'runtime-one');
    queueRelease(store, 2, 'runtime-two');
    expect(updates(store)).toHaveLength(1);
    const release = updates(store)[0]!;
    expect(store.pending(10)[0]!.route).toBe('operations');
    expect(release.announcement?.body).toContain('/config alerts');
    expect(release.announcement?.body).toContain('Removed commands');
    expect(release.announcement?.body).toContain('Runtime: runtime-one');
    store.delivered(release.id);
    queueRelease(store, 3, 'runtime-three');
    expect(store.pendingCount()).toBe(0);
    queueRelease(store, 4, 'runtime-four', {
      ...currentRelease,
      id: 'next-major',
      addedCommands: ['/new'],
      removedCommands: ['/old'],
    });
    expect(updates(store)).toHaveLength(2);
    expect(updates(store)[1]!.announcement?.body).toContain('/old');
  } finally {
    store.close();
  }
});
it('announces pins, automatic changes, exclusions and restoration with the full current list', () => {
  const store = new Store(':memory:');
  try {
    store.pin(crypto('BTC-USD'));
    store.selectAuto([equity('AAPL'), equity('MSFT')]);
    const text = updates(store).at(-1)!.announcement!.body;
    expect(text).toContain('BTC-USD');
    expect(text).toContain('AAPL');
    expect(text).toContain('MSFT');
    expect(text).toContain('Full current watchlist (3/20)');
    expect(text).toContain('Automatic discovery');
    expect(store.pending(Date.now()).every((p) => p.route === 'watchlist')).toBe(true);
    store.exclude(equity('AAPL'));
    expect(updates(store).at(-1)!.announcement!.body).toContain('Persistent exclusions**\nAAPL');
    store.restore(equity('AAPL'));
    expect(updates(store).at(-1)!.announcement!.body).toContain('Restored eligibility');
    expect(updates(store).at(-1)!.announcement!.body).toContain('Full current watchlist (2/20)');
    store.selectAuto([equity('AAPL'), equity('MSFT')]);
    expect(updates(store).at(-1)!.announcement!.body).toContain('Full current watchlist (3/20)');
    expect(updates(store)).toHaveLength(5);
  } finally {
    store.close();
  }
});
it('does not announce unchanged lists, changed ranking order, or unsuccessful mutations', () => {
  const store = new Store(':memory:');
  try {
    store.pin(crypto('BTC-USD'));
    store.selectAuto([equity('AAPL'), equity('MSFT')]);
    const revision = store.get('watch_revision', 0);
    store.pin(crypto('BTC-USD'));
    store.selectAuto([equity('MSFT'), equity('AAPL')]);
    store.restore(equity('MISSING'));
    expect(store.get('watch_revision', 0)).toBe(revision);
    expect(updates(store)).toHaveLength(2);
    for (let n = 0; n < 9; n++) store.pin(equity(`S${n}`));
    const before = updates(store).length;
    expect(() => store.pin(equity('OVER_LIMIT'))).toThrow();
    expect(updates(store)).toHaveLength(before);
  } finally {
    store.close();
  }
});
it('gives repeated state transitions distinct revisions while unchanged exclusions stay silent', () => {
  const store = new Store(':memory:');
  try {
    const i = equity('AAPL');
    store.pin(i);
    store.exclude(i);
    store.exclude(i);
    store.restore(i);
    store.pin(i);
    const events = updates(store);
    expect(events).toHaveLength(4);
    expect(new Set(events.map((e) => e.id)).size).toBe(4);
    expect(store.get('watch_revision', 0)).toBe(4);
  } finally {
    store.close();
  }
});
it('includes symbols still monitored for active ideas after watchlist removal', () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    store.saveIdea(idea(data), [], false);
    store.pin(data.instrument);
    store.exclude(data.instrument);
    const body = updates(store).at(-1)!.announcement!.body;
    expect(body).toContain('Full current watchlist (0/20)');
    expect(body).toContain('Still monitored for active ideas**\nETH-USD');
    expect(store.monitored().some((i) => i.id === data.instrument.id)).toBe(true);
  } finally {
    store.close();
  }
});
it('rolls back a watchlist mutation if its durable announcement cannot be persisted', () => {
  const store = new Store(':memory:');
  try {
    store.db.exec(
      "CREATE TRIGGER fail_announcements BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'announcement storage failed'); END;",
    );
    expect(() => store.pin(equity('AAPL'))).toThrow('announcement storage failed');
    expect(store.watchRows()).toHaveLength(0);
    expect(store.get('watch_revision', 0)).toBe(0);
  } finally {
    store.close();
  }
});
it('does not announce internal auto-flag cleanup for an already pinned symbol', () => {
  const store = new Store(':memory:');
  try {
    store.selectAuto([equity('AAPL'), equity('MSFT')]);
    store.pin(equity('AAPL'));
    const revision = store.get('watch_revision', 0);
    store.selectAuto([equity('AAPL'), equity('MSFT')]);
    expect(store.get('watch_revision', 0)).toBe(revision);
  } finally {
    store.close();
  }
});
it('queues signal events ahead of operational announcements', () => {
  const store = new Store(':memory:');
  try {
    store.pin(equity('AAPL'));
    queueRelease(store, 1, 'runtime');
    const data = fixture(),
      original = idea(data);
    const e = {
      id: 'signal',
      ideaId: original.candidate.id,
      candidate: original.candidate,
      instrument: data.instrument,
      direction: original.candidate.direction,
      strategyVersion: original.candidate.strategyVersion,
      state: 'entry_triggered' as const,
      marketTime: 1,
      recordedAt: 1,
      provenance: data.provenance,
      reasons: ['Entry confirmed'],
    };
    store.enqueue(e, 'crypto_ideas');
    expect(store.pending(Date.now())[0]!.event.id).toBe('signal');
  } finally {
    store.close();
  }
});
it('delivers queued public announcements despite provider failure without clearing its status error', async () => {
  const { vi } = await import('vitest');
  const { SignalCoordinator } = await import('../src/worker/coordinator.js');
  const store = new Store(':memory:');
  try {
    const coordinator = Object.create(SignalCoordinator.prototype) as InstanceType<
      typeof SignalCoordinator
    >;
    const publisher = { validate: vi.fn(async () => ({})), deliver: vi.fn(async () => {}) };
    Object.assign(coordinator, {
      store,
      env: {
        FREE_PLAN_CONFIRMED: 'true',
        DISCORD_TOKEN: 'fake',
        DISCORD_GUILD_ID: 'guild',
        DISCORD_APPLICATION_ID: 'application',
        ALPACA_API_KEY: 'fake',
        ALPACA_API_SECRET: 'fake',
        RELEASE_MODE: 'test',
        TEST_CHANNEL_ID: 'private-test',
        BUILD_INFO: { id: 'runtime' },
      },
      budget: { tick: () => true, status: () => ({ storageBytes: 0 }) },
      service: {
        scan: vi.fn(async () => {
          store.set('last_error_stage', 'daily_history');
          throw new Error('PROVIDER_RETRY_LATER');
        }),
      },
      client: {
        user: { id: 'bot' },
        guilds: { fetch: async () => ({}) },
        rest: { put: async () => ({}) },
      },
      publisher,
    });
    store.pin(crypto('BTC-USD'));
    const response = await coordinator.fetch(new Request('https://internal/tick'));
    expect(response.ok).toBe(true);
    expect(publisher.deliver).toHaveBeenCalledTimes(2);
    expect(publisher.deliver.mock.calls.every((c: unknown[]) => c[1] === 'private-test')).toBe(
      true,
    );
    expect(store.get('last_error', null)).toBe('PROVIDER_RETRY_LATER');
    expect(store.get('last_error_stage', null)).toBe('daily_history');
    expect(store.pendingCount()).toBe(0);
    await coordinator.fetch(new Request('https://internal/tick'));
    expect(publisher.deliver).toHaveBeenCalledTimes(2);
  } finally {
    store.close();
  }
});
