import { expect, it, vi } from 'vitest';
import { Collection, type ChatInputCommandInteraction } from 'discord.js';
import { Store } from '../src/storage.js';
import { fixture, idea } from './fixtures.js';
import {
  follow,
  preferences,
  digest,
  statistics,
  marketContext,
  activeIdeas,
} from '../src/insights.js';
import { advance, makeEvent } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';
import { simulate } from '../src/research/simulator.js';
import { replay } from '../src/research/replay.js';
import { cachedSuggestions } from '../src/discord/autocomplete.js';
import { commands, CommandHandler } from '../src/discord/commands.js';
import { QUARTER } from '../src/core/time.js';
import { Alpaca } from '../src/adapters/alpaca.js';
import { HttpClient } from '../src/adapters/http.js';

it('personal follows filter digests without changing shared pins or other members', () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    store.pin(data.instrument);
    const before = store.watchRows();
    follow(store, 'alice', data.instrument.symbol, 'entries');
    expect(preferences(store, 'bob')).toEqual([]);
    const result = advance(idea(data), data, defaults, data.provenance.asOf);
    store.saveIdea(result.idea, result.events);
    expect(
      digest(store, data.provenance.asOf, 'alice').changes.every(
        (e) => e.state === 'entry_triggered',
      ),
    ).toBe(true);
    expect(store.watchRows()).toEqual(before);
    follow(store, 'alice', data.instrument.symbol, 'all', true);
    expect(preferences(store, 'alice')).toEqual([]);
  } finally {
    store.close();
  }
});
it('counts one terminal idea and exposes unknown price instead of inventing performance', () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    const original = idea(data);
    original.candidate.entry = 112.5;
    const event = makeEvent(
      original,
      'time_exit',
      data.provenance.asOf + QUARTER,
      data,
      data.provenance.asOf + QUARTER,
      [],
    );
    store.saveIdea({ ...original, state: 'time_exit' }, [event]);
    expect(statistics(store).groups[0]).toMatchObject({
      samples: 1,
      entered: 1,
      timeExit: 1,
      unknownPrice: 1,
    });
  } finally {
    store.close();
  }
});
it('shows frozen-rule deadlines and leaves missing sector/benchmark context unknown', () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    store.pin(data.instrument);
    store.saveIdea(idea(data), [], false);
    expect(activeIdeas(store, data.provenance.asOf)[0]?.remainingSessions).toBe(2);
    const context = marketContext(store, data.provenance.asOf);
    expect(context.instruments[0]).toMatchObject({ sector: 'unknown', benchmarkTrend: 'unknown' });
    expect(context.sectors).toEqual([]);
  } finally {
    store.close();
  }
});
it('simulates next-bar fills, costs and conservative same-candle ambiguity', () => {
  const data = fixture();
  const original = idea(data);
  original.candidate.entry = 112;
  original.candidate.target = 120;
  const entry = makeEvent(
    original,
    'entry_triggered',
    data.provenance.asOf,
    data,
    data.provenance.asOf,
    [],
  );
  data.intraday = [
    {
      start: entry.marketTime,
      end: entry.marketTime + QUARTER,
      open: 113,
      high: 121,
      low: 109,
      close: 115,
      volume: 10,
    },
  ];
  const report = simulate([data], [entry], { slippageBps: 10, feeBps: 5, holdoutFraction: 0.2 });
  expect(report.trades[0]).toMatchObject({
    status: 'closed',
    ambiguous: true,
    reason: 'Stop touched',
  });
  expect(report.trades[0]?.entry).toBeCloseTo(113.113);
  expect(report.trades[0]?.rMultiple).toBeLessThan(-1);
  data.intraday[0]!.open = 109;
  expect(simulate([data], [entry]).trades[0]?.status).toBe('skipped');
});
it('does not label an arbitrary provider name as reviewed historical evidence', () => {
  const data = fixture();
  data.provenance.provider = 'provider';
  data.provenance.feed = 'feed';
  expect(replay([data], defaults).report.realHistoricalEvidence).toBe(false);
  expect(() => replay([], defaults)).toThrow('at least one');
  expect(() =>
    replay([data], defaults, [{ source: 'source', retrievedAt: 'invalid', sourceSha256: 'x' }]),
  ).toThrow('manifest');
});
it('offers cached symbol and active idea suggestions without provider calls', () => {
  expect(
    cachedSuggestions(
      { data: { name: 'chart', options: [{ name: 'symbol', value: 'eth', focused: true }] } },
      ['ETH-USD', 'BTC-USD'],
      [],
    ),
  ).toEqual([{ name: 'ETH-USD', value: 'ETH-USD' }]);
  expect(
    cachedSuggestions(
      { data: { name: 'idea', options: [{ name: 'id', value: 'eth', focused: true }] } },
      [],
      [{ id: 'abc', symbol: 'ETH-USD', state: 'watching' }],
    )[0]?.value,
  ).toBe('abc');
});
it('allows member diagnostics/preferences and restricts queue operations', async () => {
  const store = new Store(':memory:');
  try {
    const handler = new CommandHandler(
      store,
      {} as any,
      {} as any,
      { render: async () => Buffer.from('') },
      { image: () => false, status: () => ({ paused: true }) },
      'guild',
    );
    for (const commandName of [
      'health',
      'ideas',
      'digest',
      'stats',
      'context',
      'follow',
      'queue',
    ]) {
      const i = {
        guildId: 'guild',
        commandName,
        user: { id: 'member' },
        guild: {
          members: {
            fetch: async () => ({
              permissions: { has: () => false },
              roles: { cache: new Collection() },
            }),
          },
        },
        options: {
          getSubcommand: () =>
            commandName === 'follow' ? 'list' : commandName === 'queue' ? 'retry' : null,
          getString: () => null,
          getBoolean: () => false,
        },
        deferReply: vi.fn(),
        editReply: vi.fn(),
        reply: vi.fn(),
      } as unknown as ChatInputCommandInteraction;
      await handler.handle(i);
      if (commandName === 'queue') expect(i.reply).toHaveBeenCalled();
      else expect(i.editReply).toHaveBeenCalled();
    }
    expect(commands.map((c) => c.toJSON().name)).toEqual(
      expect.arrayContaining([
        'health',
        'explain',
        'ideas',
        'digest',
        'stats',
        'context',
        'follow',
        'queue',
      ]),
    );
  } finally {
    store.close();
  }
});
it('omits stale or unquoted options and chooses directional near strikes', async () => {
  const now = Date.parse('2026-10-08T16:00:00Z');
  const quote = { bp: 2, ap: 2.2, bs: 5, as: 5, t: new Date(now - 16 * 60000).toISOString() };
  const provider = new Alpaca(
    new HttpClient(
      undefined,
      async () =>
        Response.json({
          snapshots: {
            AAPL261106C00100000: { latestQuote: quote },
            AAPL261106P00100000: { latestQuote: quote },
            AAPL261106C00101000: { latestQuote: { ...quote, t: '2020-01-01' } },
            AAPL261106C00102000: {},
          },
        }),
      async () => {},
    ),
    'key',
    'secret',
  );
  const instrument = fixture().instrument;
  expect(await provider.options(instrument, { direction: 'bullish', price: 100, now })).toEqual([
    expect.objectContaining({ contract: 'AAPL261106C00100000', strike: 100 }),
  ]);
});
