import { expect, it, vi } from 'vitest';
import { ChannelType, Collection, type Client } from 'discord.js';
import { DiscordPublisher } from '../src/discord/publisher.js';
import { thresholdPublishable } from '../src/threshold/publication.js';
import { thresholdFixture, open, mature } from './threshold-fixtures.js';
import type { DataService } from '../src/data.js';

function harness(f: ReturnType<typeof thresholdFixture>) {
  const messages = new Collection<string, any>(),
    render = vi.fn(),
    dataset = vi.fn(),
    image = vi.fn();
  let now = mature;
  const channel = {
    id: 'private',
    guildId: 'guild',
    type: ChannelType.GuildText,
    isTextBased: () => true,
    guild: { members: { me: { id: 'bot' } } },
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: vi.fn(async () => messages) },
    send: vi.fn(async (payload: any) => {
      const message = {
        id: `message-${messages.size}`,
        author: { id: 'bot' },
        embeds: payload.embeds.map((e: any) => e.toJSON()),
      };
      messages.set(message.id, message);
      return message;
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
  );
  return {
    publisher,
    channel,
    render,
    dataset,
    image,
    setNow: (value: number) => {
      now = value;
    },
  };
}
it('publishes threshold alerts once with receipts, no charts, threads, or provider calls', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    await f.tick(mature);
    const e = f.pending()[0]!.event,
      h = harness(f);
    expect(thresholdPublishable(f.store, e, mature)).toBe(true);
    await h.publisher.deliver(e, 'private');
    await h.publisher.deliver(e, 'private');
    expect(h.channel.send).toHaveBeenCalledTimes(1);
    expect(f.store.receipt(e.id, 'private')).toBe('message-0');
    expect(f.state.get(m.id)!.deliveredAllowance).toBe(0);
    const payload = h.channel.send.mock.calls[0]![0];
    expect(payload.files).toBeUndefined();
    expect(payload.components).toBeUndefined();
    expect(payload.embeds[0].toJSON().image).toBeUndefined();
    const text = JSON.stringify(payload);
    expect(text).toContain('Indicative estimated return');
    expect(text).toContain('Fees not included');
    expect(text).toContain('/threshold snooze');
    expect(text).toContain('Modified indicative quote');
    expect(h.render).not.toHaveBeenCalled();
    expect(h.dataset).not.toHaveBeenCalled();
    expect(h.image).not.toHaveBeenCalled();
    expect(f.store.thread(e.ideaId)).toBeUndefined();
  } finally {
    f.store.close();
  }
});
it('reconciles a send after receipt transaction failure without duplicating the prompt', async () => {
  const f = thresholdFixture();
  try {
    f.add();
    await f.tick(open);
    await f.tick(mature);
    const e = f.pending()[0]!.event,
      h = harness(f),
      original = f.store.saveReceipt.bind(f.store);
    vi.spyOn(f.store, 'saveReceipt')
      .mockImplementationOnce(() => {
        throw new Error('receipt failure');
      })
      .mockImplementation(original);
    await expect(h.publisher.deliver(e, 'private')).rejects.toThrow('receipt failure');
    expect(f.state.reviews()).toHaveLength(0);
    await h.publisher.deliver(e, 'private');
    expect(h.channel.send).toHaveBeenCalledTimes(1);
    expect(f.state.reviews()).toHaveLength(1);
  } finally {
    f.store.close();
  }
});
it.each(['settings', 'quote', 'expiry', 'stop', 'rule', 'terminal', 'pause', 'budget'] as const)(
  'suppresses obsolete %s alerts without consuming the episode',
  async (reason) => {
    const f = thresholdFixture();
    try {
      const m = f.add();
      await f.tick(open);
      await f.tick(mature);
      const e = f.pending()[0]!.event,
        h = harness(f);
      if (reason === 'settings') f.state.configure({ contracts: false }, 'admin', mature);
      if (reason === 'quote') h.setNow(mature + 300001);
      if (reason === 'expiry') h.setNow(mature + 600000);
      if (reason === 'stop') f.state.stop(m.id, 'alice', false, mature);
      if (reason === 'rule') f.state.configure({ hours: 3 }, 'admin', mature);
      if (reason === 'terminal') {
        const current = f.state.get(m.id)!;
        current.status = 'expired';
        f.state.save(current);
      }
      if (reason === 'pause') {
        const settings = f.store.settings();
        settings.paused = true;
        f.store.set('settings', settings);
      }
      if (reason === 'budget') f.store.set('budget_paused', true);
      if (reason === 'budget')
        await expect(h.publisher.deliver(e, 'private')).rejects.toThrow('EGRESS_BUDGET_PAUSED');
      else {
        await h.publisher.deliver(e, 'private');
        expect(
          f.store.db.prepare('SELECT status FROM outbox WHERE event_id=?').get(e.id),
        ).toMatchObject({ status: 'suppressed' });
      }
      expect(h.channel.send).not.toHaveBeenCalled();
      expect(f.state.get(m.id)!.deliveredAllowance).toBe(-1);
    } finally {
      f.store.close();
    }
  },
);
it('rechecks after Discord I/O and makes a suppressed attempt eligible for a fresh later prompt', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    await f.tick(open);
    await f.tick(mature);
    const e = f.pending()[0]!.event,
      h = harness(f);
    h.channel.messages.fetch.mockImplementationOnce(async () => {
      const current = f.state.get(m.id)!;
      current.observation!.eligible = false;
      f.state.save(current);
      return new Collection();
    });
    await h.publisher.deliver(e, 'private');
    expect(h.channel.send).not.toHaveBeenCalled();
    expect(f.state.get(m.id)!.pendingId).toBeUndefined();
    await f.tick(mature + 60000);
    const next = f.pending()[0]!.event;
    expect(next.id).not.toBe(e.id);
    h.setNow(mature + 60000);
    await h.publisher.deliver(next, 'private');
    expect(h.channel.send).toHaveBeenCalledTimes(1);
  } finally {
    f.store.close();
  }
});
it('does not use the production-continuity exception reserved for existing strategy ideas', async () => {
  const { canPublishProduction } = await import('../src/worker/publication.js');
  const f = thresholdFixture();
  try {
    f.add();
    await f.tick(open);
    await f.tick(mature);
    const e = f.pending()[0]!.event;
    expect(canPublishProduction(f.store, e, false)).toBe(false);
    expect(canPublishProduction(f.store, e, true)).toBe(true);
  } finally {
    f.store.close();
  }
});
