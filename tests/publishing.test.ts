import { expect, it, vi } from 'vitest';
import { ChannelType, Collection, type Client } from 'discord.js';
import { Store } from '../src/storage.js';
import { DiscordPublisher } from '../src/discord/publisher.js';
import { fixture, idea } from './fixtures.js';
import { advance, makeEvent } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';
import { card } from '../src/discord/cards.js';
import type { DataService } from '../src/data.js';
import type { SignalEvent } from '../src/domain.js';
function harness(store: Store) {
  let seq = 0;
  const channels = new Map<string, any>();
  const makeChannel = (id: string, thread = false): any => {
    const messages = new Collection<string, any>();
    const channel: any = {
      id,
      guildId: 'guild',
      type: ChannelType.GuildText,
      archived: false,
      isTextBased: () => true,
      isThread: () => thread,
      guild: { members: { me: {} } },
      permissionsFor: () => ({ has: () => true }),
      setArchived: vi.fn(async () => {
        channel.archived = false;
      }),
      messages: {
        fetch: vi.fn(async (arg: any) => (typeof arg === 'string' ? messages.get(arg) : messages)),
      },
      send: vi.fn(async (payload: any) => {
        const message: any = {
          id: `${++seq}`,
          author: { id: 'bot' },
          embeds: payload.embeds.map((e: any) => e.toJSON()),
          hasThread: false,
          startThread: vi.fn(async () => {
            message.hasThread = true;
            message.thread = channels.get('thread');
            channels.set(message.id, message.thread);
            return message.thread;
          }),
        };
        messages.set(message.id, message);
        return message;
      }),
    };
    channels.set(id, channel);
    return channel;
  };
  const main = makeChannel('main'),
    updates = makeChannel('updates'),
    thread = makeChannel('thread', true);
  const charts = { render: vi.fn(async () => Buffer.from('chart')) };
  const data = { dataset: async () => fixture() } as unknown as DataService;
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async (id: string) => channels.get(id) },
  } as unknown as Client;
  const publisher = new DiscordPublisher(
    client,
    store,
    data,
    charts,
    { image: () => true },
    'guild',
  );
  return { main, updates, thread, charts, publisher };
}
function events(direction: 'bullish' | 'bearish' = 'bullish') {
  const data = fixture(direction),
    original = idea(data);
  const watching = makeEvent(
    original,
    'watching',
    original.candidate.breakout.end,
    data,
    data.provenance.asOf,
    ['Qualified breakout'],
  );
  return {
    data,
    original,
    watching,
    advanced: advance(original, data, defaults, data.provenance.asOf),
  };
}
it.each(['bullish', 'bearish'] as const)(
  'posts %s setup, retest and entry publicly with thread history',
  async (direction) => {
    const store = new Store(':memory:');
    try {
      const h = harness(store),
        e = events(direction);
      store.saveIdea(e.advanced.idea, [e.watching, ...e.advanced.events]);
      for (const event of [e.watching, ...e.advanced.events])
        await h.publisher.deliver(event, 'main');
      expect(h.main.send).toHaveBeenCalledTimes(3);
      expect(h.thread.send).toHaveBeenCalledTimes(2);
      expect(h.main.send.mock.calls[0][0].embeds[0].toJSON().title).toContain('AWAITING RETEST');
      expect(h.main.send.mock.calls[2][0].embeds[0].toJSON().title).toContain('ENTRY CONFIRMED');
      expect(h.thread.send.mock.calls.every((c: any) => c[0].files === undefined)).toBe(true);
      const root = await h.main.messages.fetch(store.thread(e.original.candidate.id)!.message);
      expect(root.startThread).toHaveBeenCalledTimes(1);
      const terminal: SignalEvent = {
        ...e.advanced.events.at(-1)!,
        id: 'abcdef0123456789abcdef01',
        state: 'invalidated',
        observations: ['Target touched; intrabar ordering unknown'],
      };
      store.saveIdea({ ...e.advanced.idea, state: 'invalidated' }, [terminal]);
      await h.publisher.deliver(terminal, 'updates');
      expect(h.updates.send).toHaveBeenCalledTimes(1);
      expect(h.thread.send).toHaveBeenCalledTimes(3);
      expect(h.updates.send.mock.calls[0][0].embeds[0].toJSON().description).toContain(
        'intrabar ordering unknown',
      );
    } finally {
      store.close();
    }
  },
);
it('retries a failed thread mirror without reposting the successful main card or chart', async () => {
  const store = new Store(':memory:');
  try {
    const h = harness(store),
      e = events();
    store.saveIdea(e.advanced.idea, [e.watching, ...e.advanced.events]);
    await h.publisher.deliver(e.watching, 'main');
    const entry = e.advanced.events.at(-1)!;
    h.thread.send.mockRejectedValueOnce(new Error('Discord unavailable'));
    await expect(h.publisher.deliver(entry, 'main')).rejects.toThrow('Discord unavailable');
    expect(store.receipt(entry.id, 'main')).toBeDefined();
    expect(store.receipt(entry.id, 'thread')).toBeUndefined();
    const renderCount = h.charts.render.mock.calls.length;
    await h.publisher.deliver(entry, 'main');
    await h.publisher.deliver(entry, 'main');
    expect(h.main.send).toHaveBeenCalledTimes(2);
    expect(h.thread.send).toHaveBeenCalledTimes(2); // one failure, one successful retry
    expect(h.charts.render.mock.calls.length).toBe(renderCount);
    expect(store.receipt(entry.id, 'thread')).toBeDefined();
  } finally {
    store.close();
  }
});
it('retains the public card when chart rendering fails', async () => {
  const store = new Store(':memory:');
  try {
    const h = harness(store),
      e = events();
    store.saveIdea(e.original, [e.watching]);
    h.charts.render.mockRejectedValueOnce(new Error('Browser unavailable'));
    await h.publisher.deliver(e.watching, 'main');
    expect(h.main.send.mock.calls[0][0].files).toEqual([]);
    expect(h.main.send.mock.calls[0][0].embeds[0].toJSON().fields).toContainEqual({
      name: 'Chart',
      value: 'Chart unavailable; signal details retained.',
    });
  } finally {
    store.close();
  }
});
it.each(['bullish', 'bearish'] as const)(
  'labels %s provisional geometry and replaces it at entry',
  (direction) => {
    const e = events(direction),
      watching = card(e.watching).toJSON();
    expect(e.watching.candidate.retest).toBeUndefined(); // retest was unavailable at breakout time
    expect(watching.fields!.find((f) => f.name === 'Entry condition')!.value).toContain('Awaiting');
    const ready = card(e.advanced.events[0]!).toJSON();
    expect(ready.fields!.find((f) => f.name === 'Entry condition')!.value).toContain(
      direction === 'bullish' ? 'above 112' : 'below 88',
    );
    expect(ready.fields!.find((f) => f.name === 'Planned reward/risk')!.value).toContain(
      'provisional',
    );
    expect(ready.fields!.find((f) => f.name === 'Allowed entry band')).toBeDefined();
    const entered = card(e.advanced.events[1]!).toJSON();
    expect(entered.fields!.find((f) => f.name === 'Entry signal reference')!.value).toBe(
      direction === 'bullish' ? '112.5' : '87.5',
    );
    expect(entered.fields!.find((f) => f.name === 'Planned reward/risk')!.value).not.toContain(
      'provisional',
    );
  },
);
it('recovers an existing Discord thread after its cache and saved thread ID are lost', async () => {
  const store = new Store(':memory:');
  try {
    const h = harness(store),
      e = events();
    store.saveIdea(e.advanced.idea, [e.watching, ...e.advanced.events]);
    await h.publisher.deliver(e.watching, 'main');
    const root = await h.main.messages.fetch(store.thread(e.original.candidate.id)!.message);
    root.thread = undefined; // Workers REST clients start with an empty thread cache
    store.db
      .prepare('UPDATE threads SET thread_id=NULL WHERE idea_id=?')
      .run(e.original.candidate.id);
    await h.publisher.deliver(e.advanced.events.at(-1)!, 'main');
    expect(root.startThread).toHaveBeenCalledTimes(1);
    expect(store.thread(e.original.candidate.id)?.thread).toBe('thread');
    expect(h.thread.send).toHaveBeenCalledTimes(1);
  } finally {
    store.close();
  }
});

it('publishes tracker text cards with receipts and links, without charts, threads or entry geometry', async () => {
  const { trackerEvent } = await import('../src/watch-trackers.js');
  const { volumeSpike } = await import('../src/core/trackers.js');
  const store = new Store(':memory:');
  try {
    const h = harness(store),
      d = fixture();
    const daily = d.daily.at(-1)!;
    const volume = volumeSpike(d, '1d', { ...daily, volume: 1e12 }, 2, 10)!;
    const event = trackerEvent(d, volume, daily.end);
    store.enqueue(event, 'watchlist');
    h.main.send.mockRejectedValueOnce(new Error('Unavailable'));
    await expect(h.publisher.deliver(event, 'main')).rejects.toThrow('Unavailable');
    await h.publisher.deliver(event, 'main');
    await h.publisher.deliver(event, 'main');
    expect(h.main.send).toHaveBeenCalledTimes(2);
    expect(h.charts.render).not.toHaveBeenCalled();
    expect(h.thread.send).not.toHaveBeenCalled();
    const payload = h.main.send.mock.calls[1][0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toContain('VOLUME SPIKE');
    expect(embed.fields.some((f: any) => /reward|entry|target/i.test(f.name))).toBe(false);
    expect(payload.files).toEqual([]);
    expect(payload.components[0].toJSON().components[0].url).toContain('tradingview.com');
    expect(store.receipt(event.id, 'main')).toBeDefined();
    expect(store.thread(event.ideaId)).toBeUndefined();
  } finally {
    store.close();
  }
});
