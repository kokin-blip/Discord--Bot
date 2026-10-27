import { expect, it, vi, afterEach } from 'vitest';
import { Collection, type ChatInputCommandInteraction } from 'discord.js';
import { commands, CommandHandler } from '../src/discord/commands.js';
import { cachedSuggestions } from '../src/discord/autocomplete.js';
import { thresholdFixture, open, contract } from './threshold-fixtures.js';
import type { SignalService } from '../src/service.js';
import type { DiscordPublisher } from '../src/discord/publisher.js';
import { equity } from '../src/domain.js';
afterEach(() => vi.restoreAllMocks());
function interaction(
  sub: string,
  options: Record<string, unknown> = {},
  user = 'alice',
  manager = false,
  guildId = 'guild',
) {
  return {
    commandName: 'threshold',
    guildId,
    user: { id: user },
    guild: {
      members: {
        fetch: async () => ({
          permissions: { has: () => manager },
          roles: { cache: new Collection() },
        }),
      },
    },
    options: {
      getSubcommand: () => sub,
      getString: (k: string) => options[k] ?? null,
      getNumber: (k: string) => options[k] ?? null,
      getInteger: (k: string) => options[k] ?? null,
      getBoolean: (k: string) => options[k] ?? null,
    },
    deferReply: vi.fn(),
    editReply: vi.fn(),
    reply: vi.fn(),
  } as unknown as ChatInputCommandInteraction;
}
function handler(f: ReturnType<typeof thresholdFixture>) {
  const render = vi.fn(),
    publish = vi.fn(),
    dataset = vi.fn();
  return {
    handler: new CommandHandler(
      f.store,
      { data: { dataset } } as unknown as SignalService,
      { deliver: publish } as unknown as DiscordPublisher,
      { render },
      { image: () => false, status: () => ({ paused: f.store.get('budget_paused', false) }) },
      'guild',
    ),
    render,
    publish,
    dataset,
  };
}
it('registers the full slash interface, clear-stop operation and bounded config', () => {
  const c = commands.find((c) => c.toJSON().name === 'threshold')!.toJSON();
  expect(c.options!.map((o) => o.name)).toEqual([
    'add',
    'edit',
    'list',
    'show',
    'snooze',
    'stop',
    'config',
  ]);
  const json = JSON.stringify(c);
  expect(json).toContain('clear_stop');
  expect(json).toContain('contract_loss_percent');
  expect(json).toContain('"autocomplete":true');
});
it('allows member registration, warns about public details, and makes no data or delivery requests', async () => {
  const f = thresholdFixture();
  try {
    vi.spyOn(Date, 'now').mockReturnValue(open);
    const h = handler(f),
      i = interaction('add', { contract, entry: 2 });
    await h.handler.handle(i);
    expect(f.state.all()).toHaveLength(1);
    expect(i.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('publicly'));
    expect(h.render).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.dataset).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});
it('enforces owner access and manager moderation and manager-only configuration', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add(),
      h = handler(f);
    const other = interaction('stop', { id: m.id }, 'bob');
    await h.handler.handle(other);
    expect(other.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('owner') }),
    );
    expect(f.state.get(m.id)!.status).toBe('active');
    const config = interaction('config', { enabled: false });
    await h.handler.handle(config);
    expect(config.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('administrator') }),
    );
    const mod = interaction('stop', { id: m.id }, 'moderator', true);
    await h.handler.handle(mod);
    expect(f.state.get(m.id)!.status).toBe('stopped');
  } finally {
    f.store.close();
  }
});
it('allows cached reads, safe stop and disabling during budget exhaustion; rejects adding and re-enabling', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add(),
      h = handler(f);
    f.store.set('budget_paused', true);
    for (const sub of ['list', 'show']) {
      const i = interaction(sub, { id: m.id });
      await h.handler.handle(i);
      expect(i.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ files: expect.any(Array) }),
      );
    }
    const add = interaction('add', { contract: 'AAPL261218P00100000', entry: 2 });
    await h.handler.handle(add);
    expect(add.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('budget') }),
    );
    const off = interaction('config', { enabled: false }, 'admin', true);
    await h.handler.handle(off);
    expect(f.state.config().enabled).toBe(false);
    const on = interaction('config', { enabled: true }, 'admin', true);
    await h.handler.handle(on);
    expect(f.state.config().enabled).toBe(false);
    await h.handler.handle(interaction('stop', { id: m.id }));
    expect(f.state.get(m.id)!.status).toBe('stopped');
  } finally {
    f.store.close();
  }
});
it('clears stops, rejects conflicting options, and prevents cross-guild changes', async () => {
  const f = thresholdFixture();
  try {
    const m = f.add(),
      h = handler(f);
    await h.handler.handle(interaction('edit', { id: m.id, clear_stop: true }));
    expect(f.state.get(m.id)!.stop).toBeUndefined();
    const conflict = interaction('edit', { id: m.id, clear_stop: true, stop: 1 });
    await h.handler.handle(conflict);
    expect(conflict.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not both') }),
    );
    const foreign = interaction('stop', { id: m.id }, 'alice', true, 'foreign');
    await h.handler.handle(foreign);
    expect(f.state.get(m.id)!.status).toBe('active');
  } finally {
    f.store.close();
  }
});
it('enforces per-member/server caps, duplicate contracts and compatible idea linking', () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    expect(() => f.add()).toThrow('Already tracking');
    expect(() => f.add('bob', { stop: 2.1 })).toThrow('stop below entry');
    const idea = f.autoIdea('bearish');
    expect(() => f.add('bob', { ideaId: idea.candidate.id })).toThrow('match');
    for (let n = 1; n < 5; n++)
      f.add('alice', { contract: `AAPL261218C${String(100000 + n * 1000).padStart(8, '0')}` });
    expect(() => f.add('alice', { contract: 'AAPL261218C00200000' })).toThrow('five per member');
    for (let n = 0; n < 15; n++) f.add(`user${n}`);
    expect(() => f.add('extra')).toThrow('twenty server-wide');
    f.state.stop(m.id, 'alice', false, open + 1);
    expect(() => f.add('extra')).not.toThrow();
  } finally {
    f.store.close();
  }
});
it('restricts registrations to selected or active-idea equity underlyings and valid expiries', () => {
  const f = thresholdFixture();
  try {
    expect(() => f.add('bob', { contract: 'SPX261218C00100000' })).toThrow('underlying');
    expect(() => f.add('bob', { contract: 'AAPL261019C00100000' })).toThrow('expired');
    f.store.exclude(equity('AAPL'));
    expect(() => f.add()).toThrow('underlying');
  } finally {
    f.store.close();
  }
});
it('uses cached monitor and source-idea autocomplete', () => {
  const f = thresholdFixture();
  try {
    const m = f.add();
    const request = {
      data: {
        name: 'threshold',
        options: [{ name: 'show', options: [{ name: 'id', value: 'AAP', focused: true }] }],
      },
    };
    expect(
      cachedSuggestions(request, [], [], [{ id: m.id, symbol: 'AAPL', status: 'active' }])[0]!
        .value,
    ).toBe(m.id);
    request.data.options[0]!.options[0]!.name = 'idea';
    expect(
      cachedSuggestions(
        request,
        [],
        [{ id: 'source', symbol: 'AAPL', state: 'entry_triggered' }],
      )[0]!.value,
    ).toBe('source');
  } finally {
    f.store.close();
  }
});
