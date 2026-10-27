import { reviewedNews } from './live-fixtures.js';
import { expect, it, vi } from 'vitest';
import { ChannelType, Collection, type Client } from 'discord.js';
import { DiscordPublisher } from '../src/discord/publisher.js';
import type { DataService } from '../src/data.js';
import { NewsIngestion } from '../src/news/ingestion.js';
import { NewsTransport } from '../src/news/transport.js';
import { MarketauxNews } from '../src/news/providers/marketaux.js';
import { CurrentsNews } from '../src/news/providers/currents.js';
import { GdeltNews } from '../src/news/providers/gdelt.js';
import { newsFixture } from './news-publication-fixtures.js';
import { now } from './news-fixtures.js';
it('ingests, analyzes, enqueues and publicly delivers licensed synthetic evidence with receipt recovery and failure isolation', async () => {
  const f = newsFixture();
  let clock = now,
    fail = false;
  try {
    f.news.saveConfig({ enabled: true, alerts: true, providers: { marketaux: true } });
    reviewedNews(f.news, now);
    f.store.set('soak_start', now - 86400000);
    const strategy = f.store.strategy();
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error('api_token=synthetic-secret-never-log');
      return new Response(
        JSON.stringify({
          meta: { found: 1, returned: 1, page: 1 },
          data: [
            {
              uuid: 'e2e',
              url: 'https://publisher.example/e2e',
              title: 'Test Company filed for bankruptcy',
              language: 'en',
              source: 'publisher.example',
              published_at: new Date(clock - 1000).toISOString(),
              entities: [
                {
                  symbol: 'TEST',
                  name: 'Test Company',
                  exchange: 'NASDAQ',
                  match_score: 1,
                  sentiment_score: -0.8,
                },
              ],
            },
          ],
        }),
      );
    });
    const transport = new NewsTransport(fetcher, () => clock),
      adapters = {
        marketaux: new MarketauxNews('synthetic-secret-never-log', transport),
        currents: new CurrentsNews('synthetic', transport),
        gdelt: new GdeltNews(transport),
      };
    const ingestion = new NewsIngestion(
      f.news,
      { MARKETAUX_API_TOKEN: 'synthetic-secret-never-log' },
      () => clock,
      transport,
      adapters,
    );
    expect((await ingestion.tick(clock)).status).toBe('complete');
    f.publication.queue(clock);
    const event = f.pending()[0]!.event;
    expect(event.newsReport).toBeTruthy();
    expect(JSON.stringify(event)).not.toContain('Test Company');
    const messages = new Collection<string, any>();
    const channel = {
      id: 'public',
      guildId: 'guild',
      type: ChannelType.GuildText,
      isTextBased: () => true,
      guild: { members: { me: { id: 'bot' } } },
      permissionsFor: () => ({ has: () => true }),
      messages: { fetch: async () => messages },
      send: vi.fn(async (payload: any) => {
        const message = {
          id: 'message',
          author: { id: 'bot' },
          embeds: payload.embeds.map((e: any) => e.toJSON()),
        };
        messages.set(message.id, message);
        return message;
      }),
    };
    const render = vi.fn(),
      dataset = vi.fn(),
      image = vi.fn();
    const client = {
      user: { id: 'bot' },
      channels: { fetch: async () => channel },
    } as unknown as Client;
    const publisher = new DiscordPublisher(
      client,
      f.store,
      { dataset } as unknown as DataService,
      { render },
      { image },
      'guild',
      () => clock,
      f.publication,
    );
    const save = f.store.saveReceipt.bind(f.store);
    vi.spyOn(f.store, 'saveReceipt')
      .mockImplementationOnce(() => {
        throw new Error('synthetic SQLite failure');
      })
      .mockImplementation(save);
    await expect(publisher.deliver(event, 'public')).rejects.toThrow('synthetic SQLite failure');
    f.publication.failed(clock);
    await publisher.deliver(event, 'public'); // recover bot footer, no second send
    f.store.transaction(() => {
      f.store.delivered(event.id);
      f.publication.delivered(event, clock);
    });
    f.publication.delivered(event, clock);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(f.store.receipt(event.id, 'public')).toBe('message');
    expect(ingestion.monitor.totals(clock)).toMatchObject({
      attempts: 1,
      mapped: 1,
      deliveryFailures: 1,
      privateDeliveries: 0,
      alerts: 1,
    });
    ingestion.monitor.observe(clock, 'test', true);
    expect(ingestion.monitor.report(clock).soak.start).toBe(0); // synthetic evidence cannot qualify live rollout
    expect(render).not.toHaveBeenCalled();
    expect(dataset).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    clock += 3600000;
    fail = true;
    expect((await ingestion.tick(clock)).status).toBe('failed');
    expect(JSON.stringify(ingestion.monitor.snapshot(clock))).not.toContain(
      'synthetic-secret-never-log',
    );
    expect(f.store.get('soak_start', 0)).toBe(now - 86400000);
    expect(f.store.strategy()).toEqual(strategy);
    expect(f.store.receipt(event.id, 'public')).toBe('message');
  } finally {
    vi.restoreAllMocks();
    f.store.close();
  }
});
