import { reviewedNews } from './live-fixtures.js';
import { expect, it, vi } from 'vitest';
import { ChannelType, Collection, type Client } from 'discord.js';
import { DiscordPublisher } from '../src/discord/publisher.js';
import type { DataService } from '../src/data.js';
import { newsFixture } from './news-publication-fixtures.js';
import { now, policy } from './news-fixtures.js';
function harness(f: ReturnType<typeof newsFixture>) {
  const messages = new Collection<string, any>(),
    render = vi.fn(),
    dataset = vi.fn(),
    image = vi.fn();
  const channel = {
    id: 'public',
    guildId: 'guild',
    type: ChannelType.GuildText,
    isTextBased: () => true,
    guild: { members: { me: { id: 'bot' } } },
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: vi.fn(async () => messages) },
    send: vi.fn(async (payload: any) => {
      const m = {
        id: 'message',
        author: { id: 'bot' },
        embeds: payload.embeds.map((e: any) => e.toJSON()),
        startThread: vi.fn(),
      };
      messages.set(m.id, m);
      return m;
    }),
  };
  const client = {
    user: { id: 'bot' },
    channels: { fetch: vi.fn(async () => channel) },
  } as unknown as Client;
  const publisher = new DiscordPublisher(
    client,
    f.store,
    { dataset } as unknown as DataService,
    { render },
    { image },
    'guild',
    () => now,
    f.publication,
  );
  return { channel, publisher, render, dataset, image };
}
it('delivers news once using existing receipts without charts, images, buttons or threads', async () => {
  const f = newsFixture();
  try {
    f.add();
    f.publication.queue(now);
    const event = f.pending()[0]!.event,
      h = harness(f);
    await h.publisher.deliver(event, 'public');
    await h.publisher.deliver(event, 'public');
    expect(h.channel.send).toHaveBeenCalledTimes(1);
    expect(f.store.receipt(event.id, 'public')).toBe('message');
    const payload = h.channel.send.mock.calls[0]![0];
    expect(payload.files).toBeUndefined();
    expect(payload.components).toBeUndefined();
    expect(payload.embeds[0].toJSON().image).toBeUndefined();
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.enforceNonce).toBe(true);
    expect(h.render).not.toHaveBeenCalled();
    expect(h.dataset).not.toHaveBeenCalled();
    expect(h.image).not.toHaveBeenCalled();
    expect(f.store.thread(event.ideaId)).toBeUndefined();
    await expect(h.publisher.deliver(event, 'production')).rejects.toThrow(
      'NEWS_DESTINATION_INVALID',
    );
  } finally {
    f.store.close();
  }
});
it('recovers a successful Discord send after the receipt write fails without reposting', async () => {
  const f = newsFixture();
  try {
    f.add();
    f.publication.queue(now);
    const event = f.pending()[0]!.event,
      h = harness(f);
    const original = f.store.saveReceipt.bind(f.store),
      spy = vi
        .spyOn(f.store, 'saveReceipt')
        .mockImplementationOnce(() => {
          throw new Error('synthetic receipt failure');
        })
        .mockImplementation(original);
    await expect(h.publisher.deliver(event, 'public')).rejects.toThrow('synthetic receipt failure');
    await h.publisher.deliver(event, 'public');
    spy.mockRestore();
    expect(h.channel.send).toHaveBeenCalledTimes(1);
    expect(f.store.receipt(event.id, 'public')).toBe('message');
  } finally {
    f.store.close();
  }
});
it('rechecks permissions after awaiting Discord and suppresses revoked output without sending', async () => {
  const f = newsFixture();
  try {
    f.add();
    f.publication.queue(now);
    const event = f.pending()[0]!.event,
      h = harness(f);
    h.channel.messages.fetch.mockImplementationOnce(async () => {
      f.news.savePolicy(policy('publisher', 'marketaux', { version: 2, status: 'revoked' }));
      return new Collection();
    });
    await h.publisher.deliver(event, 'public');
    expect(h.channel.send).not.toHaveBeenCalled();
    expect(f.pending()).toHaveLength(0);
    expect(f.store.receipt(event.id, 'public')).toBeUndefined();
  } finally {
    f.store.close();
  }
});
it('preserves complete required attribution by suppressing oversized templates', async () => {
  const f = newsFixture(now, true);
  try {
    for (const scope of ['provider', 'publisher'] as const)
      f.news.savePolicy(
        policy(scope, 'marketaux', {
          version: 2,
          permissions: f.permissions,
          attribution: (scope === 'provider' ? '_' : '*').repeat(512),
        }),
      );
    reviewedNews(f.news, now);
    f.add({
      headline: 'Test Company filed for bankruptcy ' + 'long text '.repeat(180),
      attribution: 'Required source attribution '.repeat(18),
    });
    f.publication.queue(now);
    const event = f.pending()[0]!.event,
      h = harness(f);
    await h.publisher.deliver(event, 'public');
    expect(h.channel.send).not.toHaveBeenCalled();
    expect(f.pending()).toHaveLength(0);
  } finally {
    f.store.close();
  }
});
