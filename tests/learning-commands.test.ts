import { expect, it, vi } from 'vitest';
import { Collection, type ChatInputCommandInteraction } from 'discord.js';
import { commands, CommandHandler } from '../src/discord/commands.js';
import { Store } from '../src/storage.js';
import type { SignalService } from '../src/service.js';
import type { DiscordPublisher } from '../src/discord/publisher.js';
it('registers learning inspection and explicit promotion/rollback commands', () => {
  const command = commands.find((c) => c.toJSON().name === 'learning')!.toJSON();
  expect(command.options?.map((o) => o.name)).toEqual([
    'report',
    'cases',
    'experiments',
    'promote',
    'rollback',
  ]);
});
it('allows member inspection but denies promotion and rollback without a manager/admin role', async () => {
  const store = new Store(':memory:');
  try {
    const handler = new CommandHandler(
      store,
      {} as SignalService,
      {} as DiscordPublisher,
      { render: async () => Buffer.from('') },
      { image: () => false, status: () => ({ paused: false }) },
      'guild',
    );
    for (const sub of ['report', 'cases', 'experiments', 'promote', 'rollback']) {
      const i = {
        guildId: 'guild',
        commandName: 'learning',
        deferred: false,
        user: { id: 'member' },
        guild: {
          members: {
            fetch: async () => ({
              permissions: { has: () => false },
              roles: { cache: new Collection() },
            }),
          },
        },
        options: { getSubcommand: () => sub },
        deferReply: vi.fn(),
        editReply: vi.fn(),
        reply: vi.fn(),
      } as unknown as ChatInputCommandInteraction;
      await handler.handle(i);
      if (['promote', 'rollback'].includes(sub))
        expect(i.reply).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining('administrator') }),
        );
      else
        expect(i.editReply).toHaveBeenCalledWith(
          expect.objectContaining({ files: expect.any(Array) }),
        );
    }
    expect(store.get('learning_last_review', null)).toBeNull();
  } finally {
    store.close();
  }
});
