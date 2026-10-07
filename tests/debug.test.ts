import { expect, it, vi } from 'vitest';
import { Store } from '../src/storage.js';
import { debugReport, debugSample } from '../src/discord/debug.js';
import { CommandHandler, commands } from '../src/discord/commands.js';
import { trackerCard } from '../src/discord/cards.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { SignalService } from '../src/service.js';
import type { DiscordPublisher } from '../src/discord/publisher.js';

it('creates a clearly labeled 2.5x synthetic sample with coherent chart data and no provider calls', () => {
  const { event, data } = debugSample(Date.now(), 'request');
  expect(event.debug).toBe(true);
  expect(event.tracker).toMatchObject({
    type: 'volume',
    timeframe: '15m',
    baseline: 1000,
    relativeVolume: 2.5,
  });
  expect(data.intraday.at(-1)).toEqual(event.candidate.breakout);
  const card = trackerCard(event).toJSON();
  expect(card.title).toContain('DEBUG TEST · SYNTHETIC');
  expect(card.description).toContain('invented prices and volume');
  expect(debugSample(event.recordedAt, 'request').event.id).toBe(event.id);
});
it('reports switches, freshness, pending warning state and cached volume eligibility without changing state', () => {
  const store = new Store(':memory:');
  try {
    const now = Date.now(),
      { data, event } = debugSample(now, 'sample');
    data.instrument.venue = 'Coinbase';
    store.pin(data.instrument);
    store.cache(data.instrument, '1d', data.daily);
    store.cache(data.instrument, '15m', data.intraday);
    store.set(`tracker:v1:${data.instrument.id}:15m`, { lastBar: event.marketTime });
    const report = debugReport(store, now, 'version', 'test');
    expect(report.alerts).toMatchObject({ enabled: true, volumeMultiplier: 2, baselineDays: 10 });
    expect(report.instruments[0]!.timeframes[1]).toMatchObject({
      timeframe: '15m',
      warmedUp: true,
      stale: false,
      volume: { thresholdMet: true, relativeVolume: 2.5 },
    });
    expect(store.pendingCount()).toBe(0);
    expect(store.activeIdeas()).toHaveLength(0);
    expect(() => debugReport(store, now, 'version', 'test', 'MISSING')).toThrow('not monitored');
    const later = debugReport(store, now + 900000, 'version', 'test');
    expect(later.instruments[0]!.timeframes[1]).toMatchObject({ stale: true });
  } finally {
    store.close();
  }
});
function harness(
  store: Store,
  sub: 'check' | 'test',
  admin = true,
  paused = false,
  channel?: string,
) {
  const publisher = { validate: vi.fn(async () => ({})), deliver: vi.fn(async () => {}) };
  const interaction = {
    guildId: 'server',
    user: { id: 'member' },
    id: 'debug-interaction',
    commandName: 'debug',
    guild: {
      members: {
        fetch: async () => ({ permissions: { has: () => admin }, roles: { cache: new Map() } }),
      },
    },
    options: { getSubcommand: () => sub, getString: () => null },
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
  const handler = new CommandHandler(
    store,
    {} as SignalService,
    publisher as unknown as DiscordPublisher,
    { render: async () => Buffer.from('chart') },
    { image: () => true, status: () => ({ paused }) },
    'server',
    undefined,
    'version',
    channel,
  );
  return { handler, interaction, publisher };
}
it('lets members inspect diagnostics during budget exhaustion without sending messages or starting scans', async () => {
  const store = new Store(':memory:');
  try {
    const h = harness(store, 'check', false, true, 'private-test');
    await h.handler.handle(h.interaction as unknown as ChatInputCommandInteraction);
    expect(h.publisher.deliver).not.toHaveBeenCalled();
    const reply = h.interaction.editReply.mock.calls as unknown as [
      { files: { attachment: Buffer; name: string }[] },
    ][];
    expect(reply[0]![0].files[0]!.name).toBe('debug-report.json');
    expect(JSON.parse(reply[0]![0].files[0]!.attachment.toString()).budget.paused).toBe(true);
    expect(store.journal()).toHaveLength(0);
  } finally {
    store.close();
  }
});
it('requires manager authorization, a private test destination and remaining resource budget for delivery tests', async () => {
  const store = new Store(':memory:');
  try {
    for (const [admin, paused, channel] of [
      [false, false, 'test'],
      [true, true, 'test'],
      [true, false, undefined],
    ] as const) {
      const h = harness(store, 'test', admin, paused, channel);
      await h.handler.handle(h.interaction as unknown as ChatInputCommandInteraction);
      expect(h.publisher.deliver).not.toHaveBeenCalled();
    }
    expect(store.journal()).toHaveLength(0);
    const h = harness(store, 'test', true, false, 'private-test');
    await h.handler.handle(h.interaction as unknown as ChatInputCommandInteraction);
    expect(h.publisher.deliver).toHaveBeenCalledTimes(1);
    expect(h.interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Runtime: version. Chart style: tv-simple-v3.'),
    );
    const calls = h.publisher.deliver.mock.calls as unknown as [any, string, any][];
    expect(calls[0]![1]).toBe('private-test');
    expect(calls[0]![0].debug).toBe(true);
    expect(store.pendingCount()).toBe(0);
    expect(store.activeIdeas()).toHaveLength(0);
    expect(store.journal()).toHaveLength(1);
    expect(store.get(`tracker:v1:${calls[0]![0].instrument.id}:15m`, null)).toBeNull();
    const command = commands.find((c) => c.toJSON().name === 'debug')!.toJSON() as any;
    expect(command.options.map((o: any) => o.name)).toEqual(['check', 'test']);
  } finally {
    store.close();
  }
});
