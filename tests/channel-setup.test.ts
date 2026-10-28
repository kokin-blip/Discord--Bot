import { expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/storage.js';
import { ChannelSetup, channelNames } from '../src/discord/channel-setup.js';
import { routes } from '../src/config.js';
function fixture() {
  const store = new Store(':memory:');
  const inventory: any[] = [];
  let seq = 0;
  const rest = {
    get: vi.fn(async () => structuredClone(inventory)),
    post: vi.fn(async (_route: string, { body }: { body: any }) => {
      const result = { ...body, id: String(++seq) };
      inventory.push(result);
      return result;
    }),
    patch: vi.fn(async (route: string, { body }: { body: any }) =>
      Object.assign(
        inventory.find((c) => route.endsWith(c.id)),
        body,
      ),
    ),
  };
  const setup = new ChannelSetup(store, { rest } as never, 'guild');
  const complete = async () => {
    for (let n = 0; n < 4; n++) await setup.ensure('bot');
  };
  return { store, inventory, rest, setup, complete };
}
it('creates seven public bot-post channels in bounded resumable steps and autoassigns routes', async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 4; n++) {
      const previous = f.rest.post.mock.calls.length;
      await f.setup.ensure('bot');
      expect(f.rest.post.mock.calls.length - previous).toBeLessThanOrEqual(2);
    }
    expect(f.inventory).toHaveLength(8);
    expect(f.inventory[0]).toMatchObject({ name: 'Trading Bot', type: ChannelType.GuildCategory });
    for (const route of routes) {
      const channel = f.inventory.find((c) => c.id === f.store.settings().channels[route]);
      expect(channel).toMatchObject({ name: channelNames[route], parent_id: '1' });
      const everyone = channel.permission_overwrites.find((p: any) => p.id === 'guild');
      expect(BigInt(everyone.allow) & PermissionFlagsBits.ViewChannel).not.toBe(0n);
      expect(BigInt(everyone.allow) & PermissionFlagsBits.SendMessagesInThreads).not.toBe(0n);
      expect(BigInt(everyone.deny) & PermissionFlagsBits.SendMessages).not.toBe(0n);
    }
    expect(f.store.get('channel_setup_status', {})).toMatchObject({ state: 'ready', error: null });
    const writes = vi.spyOn(f.store, 'set');
    await new ChannelSetup(f.store, { rest: f.rest } as never, 'guild').ensure('bot');
    expect(writes).not.toHaveBeenCalled();
    expect(f.inventory).toHaveLength(8);
  } finally {
    f.store.close();
  }
});
it('serializes concurrent setup and recovers a create accepted by Discord before a lost response', async () => {
  const f = fixture();
  try {
    const create = f.rest.post.getMockImplementation()!;
    f.rest.post.mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error('lost response');
    });
    await Promise.all([f.setup.ensure('bot'), f.setup.ensure('bot')]);
    expect(f.inventory).toHaveLength(1);
    await f.complete();
    expect(f.inventory).toHaveLength(8);
    expect(f.inventory.filter((c) => c.type === ChannelType.GuildCategory)).toHaveLength(1);
  } finally {
    f.store.close();
  }
});
it('recreates deleted managed channels while preserving explicit administrator overrides', async () => {
  const f = fixture();
  try {
    await f.complete();
    const old = f.store.settings().channels.updates;
    f.inventory.splice(
      f.inventory.findIndex((c) => c.id === old),
      1,
    );
    const settings = f.store.settings();
    settings.channels.summaries = 'custom';
    f.store.set('settings', settings);
    f.store.set('managed_channel_overrides', { summaries: 'custom' });
    await f.setup.ensure('bot');
    expect(f.store.settings().channels.updates).not.toBe(old);
    expect(f.store.settings().channels.summaries).toBe('custom');
    expect(f.rest.post).toHaveBeenCalledTimes(9);
  } finally {
    f.store.close();
  }
});
it('retains successful steps after permission failures and exposes sanitized diagnostics', async () => {
  const f = fixture();
  try {
    const create = f.rest.post.getMockImplementation()!;
    f.rest.post
      .mockImplementationOnce(create)
      .mockRejectedValueOnce(Object.assign(new Error('secret-token'), { status: 403 }));
    const status = await f.setup.ensure('bot');
    expect(status).toMatchObject({ state: 'error', error: 'CHANNEL_SETUP_MISSING_PERMISSIONS' });
    expect(JSON.stringify(status)).not.toContain('secret-token');
    expect(f.store.get('managed_channels', {})).toMatchObject({ categoryId: '1' });
    await f.complete();
    expect(f.inventory).toHaveLength(8);
  } finally {
    f.store.close();
  }
});
it('adds entries to an existing six-channel installation without replacing its channels or overrides', async () => {
  const f = fixture();
  try {
    await f.complete();
    const settings = f.store.settings();
    const previous = { ...settings.channels };
    const state = f.store.get<{ channels: Record<string, string> }>('managed_channels', {
      channels: {},
    });
    f.inventory.splice(
      f.inventory.findIndex((c) => c.id === settings.channels.entries),
      1,
    );
    delete settings.channels.entries;
    delete previous.entries;
    delete state.channels.entries;
    settings.channels.summaries = 'custom';
    previous.summaries = 'custom';
    f.store.set('settings', settings);
    f.store.set('managed_channels', state);
    f.store.set('managed_channel_overrides', { summaries: 'custom' });
    f.rest.post.mockClear();
    await f.setup.ensure('bot');
    expect(f.rest.post).toHaveBeenCalledTimes(1);
    expect(f.rest.post.mock.calls[0]![1].body).toMatchObject({ name: 'entries', parent_id: '1' });
    expect(f.store.settings().channels).toMatchObject(previous);
    expect(f.store.settings().channels.entries).toBeDefined();
    await f.setup.ensure('bot');
    expect(f.rest.post).toHaveBeenCalledTimes(1);
  } finally {
    f.store.close();
  }
});
