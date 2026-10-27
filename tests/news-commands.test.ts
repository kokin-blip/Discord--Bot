import { afterEach, expect, it, vi } from 'vitest';
import { Collection, type ChatInputCommandInteraction } from 'discord.js';
import { commands, CommandHandler } from '../src/discord/commands.js';
import type { SignalService } from '../src/service.js';
import type { DiscordPublisher } from '../src/discord/publisher.js';
import { newsFixture } from './news-publication-fixtures.js';
import { now, policy } from './news-fixtures.js';
afterEach(() => vi.restoreAllMocks());
function interaction(
  sub: string,
  admin = false,
  roles: string[] = [],
  options: Record<string, unknown> = {},
) {
  return {
    id: 'synthetic-interaction',
    guildId: 'guild',
    commandName: 'news',
    deferred: false,
    user: { id: 'member' },
    guild: {
      members: {
        fetch: async () => ({
          permissions: { has: () => admin },
          roles: { cache: new Collection(roles.map((role) => [role, {}])) },
        }),
      },
    },
    options: {
      getSubcommand: () => sub,
      getString: (key: string) => options[key] ?? null,
      getBoolean: (key: string) => options[key] ?? null,
      getInteger: (key: string) => options[key] ?? null,
    },
    deferReply: vi.fn(),
    editReply: vi.fn(),
    reply: vi.fn(),
  } as unknown as ChatInputCommandInteraction;
}
function handler(f: ReturnType<typeof newsFixture>, paused = false) {
  const dataset = vi.fn(),
    render = vi.fn(),
    publish = vi.fn();
  return {
    handler: new CommandHandler(
      f.store,
      { data: { dataset } } as unknown as SignalService,
      { deliver: publish } as unknown as DiscordPublisher,
      { render },
      { image: () => false, status: () => ({ paused }) },
      'guild',
      undefined,
      'test',
      'private',
      'test',
      f.publication,
    ),
    dataset,
    render,
    publish,
  };
}
it('registers the exact news command surface with cached symbol autocomplete and bounded caps', () => {
  const command = commands.find((c) => c.toJSON().name === 'news')!.toJSON();
  expect(command.options?.map((o) => o.name)).toEqual([
    'latest',
    'sentiment',
    'sources',
    'status',
    'config',
  ]);
  const json = JSON.stringify(command);
  expect(json).toContain('"autocomplete":true');
  expect(json).toContain('marketaux_cap');
  expect(json).toContain('"max_value":60');
});
it('allows cached member reads but restricts status and configuration to managers/admins', async () => {
  const f = newsFixture();
  try {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    f.add();
    const h = handler(f);
    for (const sub of ['latest', 'sentiment', 'sources', 'status', 'config']) {
      const i = interaction(sub);
      await h.handler.handle(i);
      if (['status', 'config'].includes(sub))
        expect(i.reply).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining('administrator') }),
        );
      else expect(i.editReply).toHaveBeenCalled();
    }
    expect(h.dataset).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    const settings = f.store.settings();
    settings.managerRole = 'manager';
    f.store.set('settings', settings);
    for (const i of [interaction('status', true), interaction('status', false, ['manager'])]) {
      await h.handler.handle(i);
      expect(i.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ files: expect.any(Array) }),
      );
    }
  } finally {
    f.store.close();
  }
});
it('includes licensed attribution and links in sentiment and never exposes forbidden headlines', async () => {
  const f = newsFixture();
  try {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    f.add({ headline: 'Test Company beats estimates' });
    const h = handler(f),
      i = interaction('sentiment', false, [], { symbol: 'TEST' });
    await h.handler.handle(i);
    const text = JSON.stringify(vi.mocked(i.editReply).mock.calls);
    expect(text).toContain('Synthetic publisher');
    expect(text).toContain('https://publisher.example/');
    expect(text).toContain('marketaux');
    expect(text).toContain('local');
    const latest = interaction('latest');
    await h.handler.handle(latest);
    expect(JSON.stringify(vi.mocked(latest.editReply).mock.calls)).not.toContain(
      'Test Company beats estimates',
    );
    f.news.savePolicy(policy('publisher', 'marketaux', { version: 2, status: 'revoked' }));
    const blocked = interaction('sentiment');
    await h.handler.handle(blocked);
    expect(blocked.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'No cached sentiment has current publication permission.',
      }),
    );
  } finally {
    f.store.close();
  }
});
it('can disable news while resource-paused, suppresses pending deliveries and only reduces caps', async () => {
  const f = newsFixture();
  try {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    f.add();
    f.publication.queue(now);
    expect(f.pending()).toHaveLength(1);
    const h = handler(f, true),
      i = interaction('config', true, [], { enabled: false, marketaux_cap: 10 });
    await h.handler.handle(i);
    expect(f.news.config()).toMatchObject({ enabled: false, dailyCaps: { marketaux: 10 } });
    expect(f.pending()).toHaveLength(0);
    const increase = interaction('config', true, [], { marketaux_cap: 11 });
    await h.handler.handle(increase);
    expect(increase.editReply).toHaveBeenCalledWith('News request caps may only be reduced.');
    expect(f.news.config().dailyCaps.marketaux).toBe(10);
  } finally {
    f.store.close();
  }
});
it('returns unavailable safely when the news schema could not initialize', async () => {
  const f = newsFixture();
  try {
    const h = handler(f);
    const unavailable = new CommandHandler(
      f.store,
      {} as SignalService,
      {} as DiscordPublisher,
      h.handler.charts,
      h.handler.budget,
      'guild',
    );
    const i = interaction('latest');
    await unavailable.handle(i);
    expect(i.editReply).toHaveBeenCalledWith(
      'News is unavailable; market monitoring remains independent.',
    );
  } finally {
    f.store.close();
  }
});
it('keeps status free of credentials and exposes provider suspension diagnostics', async () => {
  const f = newsFixture();
  try {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    f.store.set('news_provider:marketaux', {
      credentialHash: 'SYNTHETIC_SECRET_HASH',
      diagnostic: 'NEWS_CREDENTIAL_MISSING',
      suspended: true,
    });
    const i = interaction('status', true);
    await handler(f).handler.handle(i);
    const payload = vi.mocked(i.editReply).mock.calls[0]![0] as { files: { attachment: Buffer }[] };
    const text = payload.files[0]!.attachment.toString();
    expect(text).not.toContain('SYNTHETIC_SECRET_HASH');
    expect(text).toContain('NEWS_CREDENTIAL_MISSING');
  } finally {
    f.store.close();
  }
});

it('retires private smoke requests and exposes sanitized manager review snapshots', async () => {
  const f = newsFixture();
  try {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const h = handler(f),
      i = interaction('status', true, [], { smoke: true });
    await h.handler.handle(i);
    const reply = i.editReply as ReturnType<typeof vi.fn>;
    const attachment = reply.mock.calls[0]![0].files[0].attachment.toString();
    const status = JSON.parse(attachment);
    expect(status.smoke).toBeUndefined();
    const command = commands.find((c) => c.toJSON().name === 'news')!.toJSON();
    const statusCommand = command.options?.find((o) => o.name === 'status');
    expect(
      statusCommand && 'options' in statusCommand ? (statusCommand.options ?? []) : [],
    ).toHaveLength(0);
    expect(f.store.db.prepare('SELECT * FROM news_smoke_jobs').all()).toEqual([]);
    expect(status.monitoring.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(status.monitoring.accuracy).toBeNull();
    expect(h.dataset).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    const config = f.news.config();
    const mixed = interaction('config', true, [], {
      enabled: false,
      review_sha256: status.monitoring.sha256,
    });
    await h.handler.handle(mixed);
    expect(mixed.editReply).toHaveBeenCalledWith('NEWS_ROLLOUT_REVIEW_BLOCKED');
    expect(f.news.config()).toEqual(config);
    const rejected = interaction('config', true, [], {
      review_sha256: status.monitoring.sha256,
      reviewed_mappings: 1,
      false_mappings: 0,
      reviewed_alerts: 0,
      false_alerts: 0,
      free_plan_verified: true,
    });
    await h.handler.handle(rejected);
    expect(rejected.editReply).toHaveBeenCalledWith('NEWS_ROLLOUT_REVIEW_BLOCKED');
  } finally {
    f.store.close();
  }
});
