import { expect, it, vi } from 'vitest';
import { Store } from '../src/storage.js';
import { fixture, idea } from './fixtures.js';
import { defaults } from '../src/config.js';
import { findRetest, advance, makeEvent } from '../src/core/strategy.js';
import { deliveryContext } from '../src/discord/delivery-context.js';
import { canPublishProduction } from '../src/worker/publication.js';
import { DataService } from '../src/data.js';
import { SignalService } from '../src/service.js';
import { crypto, equity, type MarketDataProvider } from '../src/domain.js';
import { QUARTER, utcDate } from '../src/core/time.js';

it('finds a retest under frozen rules after the current strategy rejects its volume', () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    const old = idea(data);
    delete old.candidate.retest;
    store.saveStrategy({ ...defaults, breakoutVolume: 5 });
    old.candidate.retest = findRetest(
      data,
      old.candidate,
      store.version(old.candidate.strategyVersion),
      data.provenance.asOf,
    );
    expect(
      advance(old, data, defaults, data.provenance.asOf).events.some(
        (e) => e.state === 'entry_triggered',
      ),
    ).toBe(true);
  } finally {
    store.close();
  }
});

it('distinguishes stale entry and obsolete setup delivery without mutating journal evidence', () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    const result = advance(idea(data), data, defaults, data.provenance.asOf);
    const entry = result.events.find((e) => e.state === 'entry_triggered')!;
    store.saveIdea(result.idea, result.events);
    expect(deliveryContext(store, entry, entry.marketTime + 46 * 60_000)).toContain(
      'Historical entry',
    );
    store.saveIdea({ ...result.idea, state: 'invalidated' }, []);
    expect(deliveryContext(store, entry, entry.marketTime)).toContain('now invalidated');
    expect(store.journal(entry.ideaId).find((e) => e.id === entry.id)).toEqual(entry);
  } finally {
    store.close();
  }
});

it('continues only already published production ideas when new publication is blocked', () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    const event = makeEvent(
      idea(data),
      'entry_triggered',
      data.provenance.asOf,
      data,
      data.provenance.asOf,
      [],
    );
    expect(canPublishProduction(store, event, false)).toBe(false);
    store.set(`production_idea:${event.ideaId}`, event.strategyVersion);
    expect(canPublishProduction(store, event, false)).toBe(true);
    expect(canPublishProduction(store, { ...event, ideaId: 'new' }, false)).toBe(false);
  } finally {
    store.close();
  }
});

it('loads crypto data without asking the equity calendar', async () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    store.cache(data.instrument, '1d', data.daily);
    store.cache(crypto('BTC-USD'), '1d', data.benchmark);
    const calendar = vi.fn(async () => {
      throw new Error('EQUITY_OUTAGE');
    });
    const service = new DataService(
      store,
      { calendar } as unknown as MarketDataProvider,
      {} as MarketDataProvider,
    );
    expect((await service.dataset(data.instrument, data.provenance.asOf)).sessions).toEqual([]);
    expect(calendar).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

it('evaluates healthy equities when crypto refresh fails', async () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    data.instrument = equity('TEST');
    data.provenance.delayMinutes = 16;
    data.sessions = [
      {
        date: utcDate(data.intraday[0]!.start),
        open: data.intraday[0]!.start,
        close: data.intraday[0]!.end,
      },
    ];
    const now = data.provenance.asOf + 16 * 60_000;
    store.pin(data.instrument);
    store.pin(crypto('BTC-USD'));
    store.saveIdea(idea(data), [], false);
    store.set('last_scan', now - 300_000);
    store.set('discovery_day', utcDate(now));
    const service = new SignalService(store, {
      refreshDaily: async (list: any[]) => {
        if (list[0]?.market === 'crypto') throw new Error('PROVIDER_RETRY_LATER');
      },
      refreshIntraday: async () => {},
      dataset: async (i: any) => {
        if (i.market === 'crypto') throw new Error('MISSING_DAILY_BARS');
        return data;
      },
    } as unknown as DataService);
    await service.scan(now);
    expect(store.pending(now).some((p) => p.event.state === 'entry_triggered')).toBe(true);
    expect(store.get('refresh_error:crypto:daily', null)).not.toBeNull();
  } finally {
    store.close();
  }
});

it('labels a downward level crossing using the confirming intraday candle', () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    const active = idea(data);
    store.saveIdea(active, [], false);
    data.daily.at(-1)!.close = data.daily.at(-2)!.close + 1;
    const now = data.daily.at(-1)!.end + 2 * QUARTER;
    data.intraday = [active.candidate.level + 1, active.candidate.level - 1].map((close, n) => ({
      start: now - (2 - n) * QUARTER,
      end: now - (1 - n) * QUARTER,
      open: close,
      close,
      high: close + 0.2,
      low: close - 0.2,
      volume: 10,
    }));
    (new SignalService(store, {} as DataService) as any).alerts(data, now);
    expect(
      store.pending(now).find((p) => p.event.reasons[0]?.startsWith('level cross'))?.event
        .direction,
    ).toBe('bearish');
  } finally {
    store.close();
  }
});

it('delivers an existing production exit even when unrelated routes and new-version validation are blocked', async () => {
  const { SignalCoordinator } = await import('../src/worker/coordinator.js');
  const store = new Store(':memory:');
  try {
    const data = fixture();
    const original = idea(data);
    original.candidate.entry = 112.5;
    const now = Date.now();
    const exit = makeEvent(original, 'invalidated', now, data, now, ['Close invalidation']);
    store.saveIdea({ ...original, state: 'invalidated' }, [exit]);
    store.set(`production_idea:${exit.ideaId}`, exit.strategyVersion);
    const settings = store.settings();
    settings.channels.updates = 'updates';
    store.set('settings', settings);
    const deliver = vi.fn(async () => {});
    const coordinator = Object.create(SignalCoordinator.prototype) as InstanceType<
      typeof SignalCoordinator
    >;
    Object.assign(coordinator, {
      store,
      env: {
        FREE_PLAN_CONFIRMED: 'true',
        DISCORD_TOKEN: 'fake',
        DISCORD_GUILD_ID: 'guild',
        DISCORD_APPLICATION_ID: 'app',
        ALPACA_API_KEY: 'fake',
        ALPACA_API_SECRET: 'fake',
        RELEASE_MODE: 'production',
        TEST_CHANNEL_ID: 'test',
      },
      budget: { tick: () => true, status: () => ({ storageBytes: 0 }) },
      service: { scan: async () => {} },
      client: {
        user: { id: 'bot' },
        guilds: { fetch: async () => ({}) },
        rest: { put: async () => ({}) },
      },
      publisher: { validate: async () => ({}), deliver },
    });
    const response = await coordinator.fetch(new Request('https://internal/tick'));
    expect(response.ok).toBe(true);
    expect(deliver).toHaveBeenCalledWith(exit, 'updates');
    expect(store.get<string[]>('publication_blockers', [])).toContain(
      'CONFIGURE_CHANNEL:equity_ideas',
    );
  } finally {
    store.close();
  }
});

it('does not starve an eligible existing-call update behind blocked new calls', () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    const original = idea(data);
    const now = Date.now();
    const event = makeEvent(original, 'watching', now, data, now, []);
    for (let n = 0; n < 30; n++)
      store.enqueue({ ...event, id: `blocked-${n}`, ideaId: `new-${n}` }, 'crypto_ideas');
    const exit = {
      ...event,
      id: 'existing-exit',
      ideaId: 'existing',
      state: 'invalidated' as const,
    };
    store.enqueue(exit, 'updates');
    store.set('production_idea:existing', exit.strategyVersion);
    expect(store.pending(now, true).map((p) => p.event.id)).toEqual(['existing-exit']);
  } finally {
    store.close();
  }
});
