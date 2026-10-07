import { expect, it, vi } from 'vitest';
import { ChannelType, Collection, type Client } from 'discord.js';
import { Store } from '../src/storage.js';
import { DiscordPublisher } from '../src/discord/publisher.js';
import { fixture, idea } from './fixtures.js';
import { advance, makeEvent } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';
import { card, publicCard } from '../src/discord/cards.js';
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
      expect(h.main.send.mock.calls[2][0].embeds[0].toJSON().title).toContain(
        direction === 'bullish' ? 'BUY IN NOW ✅' : 'BEARISH ENTRY ✅',
      );
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
      value: 'Chart unavailable or chart allowance reached; full alert details are shown above.',
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

it('publishes tracker chart cards with receipts and links, without threads or entry geometry', async () => {
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
    expect(h.charts.render).toHaveBeenCalledTimes(2); // failed Discord send retried; receipt then stops re-rendering
    const rendered = h.charts.render.mock.calls as unknown as [any, any, SignalEvent][];
    expect(rendered[0]![1]).toBeUndefined(); // no fake strategy levels
    expect(rendered[0]![2]).toEqual(event);
    expect(rendered[0]![0].daily.at(-1)).toEqual(event.candidate.breakout);
    expect(rendered[0]![0].daily.every((b: any) => b.end <= event.marketTime)).toBe(true);
    expect(rendered[0]![0].intraday.every((b: any) => b.end <= event.marketTime)).toBe(true);
    expect(h.thread.send).not.toHaveBeenCalled();
    const payload = h.main.send.mock.calls[1][0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toContain('VOLUME SPIKE');
    expect(embed.fields.some((f: any) => /reward|entry|target/i.test(f.name))).toBe(false);
    expect(payload.files).toHaveLength(1);
    expect(embed.image?.url).toBe('attachment://chart.png');
    expect(payload.components[0].toJSON().components[0].url).toContain('tradingview.com');
    expect(store.receipt(event.id, 'main')).toBeDefined();
    expect(store.thread(event.ideaId)).toBeUndefined();
  } finally {
    store.close();
  }
});

it.each(['render_failure', 'image_allowance'] as const)(
  'keeps tracker text and link when chart delivery hits %s',
  async (failure) => {
    const { trackerEvent } = await import('../src/watch-trackers.js');
    const { volumeSpike } = await import('../src/core/trackers.js');
    const store = new Store(':memory:');
    try {
      const h = harness(store),
        d = fixture(),
        bar = d.daily.at(-1)!;
      const event = trackerEvent(
        d,
        volumeSpike(d, '1d', { ...bar, volume: 1e12 }, 2, 10)!,
        bar.end,
      );
      store.enqueue(event, 'watchlist');
      if (failure === 'render_failure')
        h.charts.render.mockRejectedValueOnce(new Error('Unavailable'));
      else h.publisher.budget.image = () => false;
      await h.publisher.deliver(event, 'main');
      await h.publisher.deliver(event, 'main');
      expect(h.main.send).toHaveBeenCalledTimes(1);
      const payload = h.main.send.mock.calls[0][0];
      expect(payload.files).toEqual([]);
      expect(payload.components[0].toJSON().components[0].url).toContain('tradingview.com');
      expect(payload.embeds[0].toJSON().title).toContain('VOLUME SPIKE');
    } finally {
      store.close();
    }
  },
);

it('renders and delivers a synthetic debug snapshot without market-data access or real-idea mutations', async () => {
  const { debugSample } = await import('../src/discord/debug.js');
  const store = new Store(':memory:');
  try {
    const h = harness(store),
      { event, data } = debugSample(Date.now(), 'delivery-test');
    h.publisher.data.dataset = async () => {
      throw new Error('Market data must not be requested');
    };
    store.recordEvent(event);
    await h.publisher.deliver(event, 'main', data);
    await h.publisher.deliver(event, 'main', data);
    expect(h.main.send).toHaveBeenCalledTimes(1);
    expect(h.charts.render).toHaveBeenCalledTimes(1);
    expect(h.main.send.mock.calls[0][0].embeds[0].toJSON().title).toContain(
      'DEBUG TEST · SYNTHETIC',
    );
    expect(h.main.send.mock.calls[0][0].embeds[0].toJSON().image.url).toBe(
      `attachment://chart-tv-dark-v2-${event.id}.png`,
    );
    expect(store.get('debug_last_delivery', {})).toMatchObject({
      chartAttached: true,
      chartStyleVersion: 'tv-dark-v2',
      channel: 'main',
    });
    expect(store.pendingCount()).toBe(0);
    expect(store.activeIdeas()).toHaveLength(0);
    expect(h.thread.send).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

it.each(['bullish', 'bearish'] as const)(
  'delivers %s entries and thread updates without charts when browser or image allowance is exhausted',
  async (direction) => {
    for (const limit of ['browser', 'images'] as const) {
      const store = new Store(':memory:');
      try {
        const h = harness(store),
          e = events(direction);
        store.saveIdea(e.advanced.idea, [e.watching, ...e.advanced.events]);
        await h.publisher.deliver(e.watching, 'main');
        if (limit === 'browser')
          h.charts.render.mockRejectedValue(new Error('BROWSER_FREE_ALLOWANCE_UNAVAILABLE'));
        else h.publisher.budget.image = () => false;
        const entry = e.advanced.events.find((event) => event.state === 'entry_triggered')!;
        expect(entry).toBeDefined();
        await h.publisher.deliver(entry, 'main');
        await h.publisher.deliver(entry, 'main');
        const payload = h.main.send.mock.calls[1]![0];
        const embed = payload.embeds[0].toJSON();
        expect(payload.files).toHaveLength(0);
        expect(embed.image).toBeUndefined();
        expect(embed.fields).toEqual(expect.arrayContaining(publicCard(entry).toJSON().fields!));
        expect(embed.fields).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'Chart' })]),
        );
        expect(payload.components).toHaveLength(1);
        expect(h.main.send).toHaveBeenCalledTimes(2);
        expect(h.thread.send).toHaveBeenCalledTimes(1);
        expect(store.receipt(entry.id, 'main')).toBeTruthy();
        expect(store.receipt(entry.id, 'thread')).toBeTruthy();
        expect(store.get('budget_paused', false)).toBe(false);
      } finally {
        store.close();
      }
    }
  },
);

it.each(['bullish', 'bearish'] as const)(
  'keeps %s entry card compact and posts detailed reasoning even when entry creates the thread',
  async (direction) => {
    const store = new Store(':memory:');
    try {
      const h = harness(store),
        e = events(direction);
      const entry = e.advanced.events.find((event) => event.state === 'entry_triggered')!;
      store.saveIdea(e.advanced.idea, [entry]);
      await h.publisher.deliver(entry, 'main');
      await h.publisher.deliver(entry, 'main');
      const main = h.main.send.mock.calls[0][0].embeds[0].toJSON();
      const detail = h.thread.send.mock.calls[0][0].embeds[0].toJSON();
      expect(main.title).toContain(direction === 'bullish' ? 'BUY IN NOW ✅' : 'BEARISH ENTRY ✅');
      expect(main.fields.some((f: any) => f.name === 'Interpretation')).toBe(false);
      expect(main.fields.find((f: any) => f.name === 'Data').value).toContain('Age at display:');
      expect(main.fields.find((f: any) => f.name === 'R/R').value).toBe('3:1');
      expect(
        main.fields.some(
          (f: any) =>
            f.name === (direction === 'bullish' ? 'Minimum buy-in reference' : 'Entry price band'),
        ),
      ).toBe(true);
      expect(detail.description).toBe(card(entry).toJSON().description);
      expect(detail.fields.some((f: any) => f.name === 'Interpretation')).toBe(true);
      expect(detail.image).toBeUndefined();
      expect(h.main.send).toHaveBeenCalledTimes(1);
      expect(h.thread.send).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  },
);

it.each(['final_target', 'invalidated', 'time_exit'] as const)(
  'shows a sell recommendation for bullish %s after entry, with discretion and ambiguity retained',
  (state) => {
    const e = events();
    const exit = {
      ...e.advanced.events.at(-1)!,
      state,
      observations: ['Target touched; intrabar ordering unknown'],
    };
    const embed = publicCard(exit).toJSON();
    expect(embed.title).toContain('SELL RECOMMENDED NOW 💰');
    expect(embed.description).toContain('You may hold at your own discretion.');
    expect(embed.description).toContain('intrabar ordering unknown');
    expect(embed.fields!.find((f) => f.name === 'Data')!.value).toContain('Age at display:');
    expect(publicCard({ ...e.watching, state }).toJSON().title).not.toContain('SELL RECOMMENDED');
    const bearish = { ...events('bearish').advanced.events.at(-1)!, state };
    expect(publicCard(bearish).toJSON().title).toContain('EXIT RECOMMENDED NOW 💰');
  },
);
