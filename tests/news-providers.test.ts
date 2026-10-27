import { expect, it, vi } from 'vitest';
import { MarketauxNews } from '../src/news/providers/marketaux.js';
import { CurrentsNews } from '../src/news/providers/currents.js';
import { GdeltNews } from '../src/news/providers/gdelt.js';
import { NewsTransport, NewsError, retryAfter } from '../src/news/transport.js';
import type { NewsProvider, NewsQuery } from '../src/news/types.js';
import { NEWS_LIMITS } from '../src/news/config.js';
import { now } from './news-fixtures.js';
const query = (provider: NewsProvider): NewsQuery => ({
  id: 'query',
  provider,
  terms: ['Test Company'],
  symbols: [],
  domains: ['publisher.example'],
  startAt: now - 3600000,
  endAt: now,
  page: 1,
  attemptId: 'attempt',
});
const signal = () => new AbortController().signal;
const marketaux = {
  meta: { found: 10, returned: 1, page: 1 },
  data: [
    {
      uuid: 'm1',
      title: 'Synthetic earnings',
      description: 'Synthetic description',
      url: 'https://publisher.example/story?utm_source=x&id=1',
      source: 'publisher.example',
      language: 'en',
      published_at: '2026-10-09T11:59:59.123456Z',
      snippet: 'Do not retain full text',
      image_url: 'https://publisher.example/picture',
      entities: [
        {
          symbol: 'TEST',
          name: 'Test Company',
          exchange: 'NASDAQ',
          match_score: 12.13,
          sentiment_score: -0.3,
        },
      ],
    },
  ],
};
it('builds the bounded Marketaux request and preserves entity sentiment and UTC provenance', async () => {
  const fetcher = vi.fn(async () => Response.json(marketaux));
  const adapter = new MarketauxNews('private-key', new NewsTransport(fetcher, () => now));
  const page = await adapter.fetchPage(
    { ...query('marketaux'), symbols: ['TEST'], terms: [] },
    signal(),
  );
  const [input, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
  const url = new URL(input);
  expect(url.origin + url.pathname).toBe('https://api.marketaux.com/v1/news/all');
  expect(url.searchParams.get('limit')).toBe('3');
  expect(url.searchParams.get('page')).toBe('1');
  expect(url.searchParams.get('symbols')).toBe('TEST');
  expect(url.searchParams.get('domains')).toBe('publisher.example');
  expect(url.searchParams.get('published_after')).toBe('2026-10-09T11:00:00');
  expect(init.redirect).toBe('error');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(page.pagination.truncated).toBe(true);
  expect(page.observations[0]).toMatchObject({
    attemptId: 'attempt',
    publishedAt: now - 877,
    timestampBasis: 'publication',
    url: 'https://publisher.example/story?id=1',
    entities: [{ symbol: 'TEST', matchScore: 12.13, sentimentScore: -0.3 }],
  });
  expect(JSON.stringify(page)).not.toContain('Do not retain full text');
  expect(JSON.stringify(page)).not.toContain('image_url');
});
it('builds Currents Bearer/domain search and parses offset publication time', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      status: 'ok',
      news: [
        {
          id: 'c1',
          title: 'Synthetic headline',
          url: 'https://publisher.example/story',
          language: 'en',
          published: '2026-10-09 05:00:00 -0700',
          category: ['business'],
        },
      ],
    }),
  );
  const page = await new CurrentsNews(
    'private-key',
    new NewsTransport(fetcher, () => now),
  ).fetchPage(query('currents'), signal());
  const [input, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
  const url = new URL(input);
  expect(url.searchParams.get('start_date')).toBe('2026-10-09T11:00:00.000Z');
  expect(url.searchParams.get('page_size')).toBe('20');
  expect(url.searchParams.has('apiKey')).toBe(false);
  expect(init.headers).toEqual({ Authorization: 'Bearer private-key' });
  expect(page.observations[0]).toMatchObject({ publishedAt: now, firstSeenAt: null, entities: [] });
});
it('uses GDELT exact-domain English ArtList and keeps first-seen separate from publication', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      articles: [
        {
          url: 'https://publisher.example/story',
          title: 'Synthetic',
          seendate: '20261009T115959Z',
          language: 'English',
          domain: 'publisher.example',
        },
      ],
    }),
  );
  const page = await new GdeltNews(new NewsTransport(fetcher, () => now)).fetchPage(
    query('gdelt'),
    signal(),
  );
  const [input] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
  const url = new URL(input);
  expect(url.searchParams.get('query')).toContain('domainis:publisher.example');
  expect(url.searchParams.get('query')).toContain('sourcelang:english');
  expect(url.searchParams.get('startdatetime')).toBe('20261009110000');
  expect(url.searchParams.get('maxrecords')).toBe('20');
  expect(page.observations[0]).toMatchObject({
    publishedAt: null,
    firstSeenAt: now - 1000,
    timestampBasis: 'provider_first_seen',
    language: 'en',
    entities: [],
  });
});
it('rejects malformed contracts and invalid dates without leaking raw provider data', async () => {
  for (const data of [
    { status: 'error', message: 'private-key' },
    {
      status: 'ok',
      news: [
        {
          id: 'c1',
          url: 'https://publisher.example/story',
          language: 'en',
          published: '2026-10-09',
        },
      ],
    },
  ]) {
    const adapter = new CurrentsNews(
      'private-key',
      new NewsTransport(
        async () => Response.json(data),
        () => now,
      ),
    );
    await expect(adapter.fetchPage(query('currents'), signal())).rejects.toThrow(
      'NEWS_INVALID_RESPONSE',
    );
  }
  const fetcher = vi.fn(async () => Response.json({}));
  await expect(
    new GdeltNews(new NewsTransport(fetcher)).fetchPage(
      { ...query('gdelt'), domains: [] },
      signal(),
    ),
  ).rejects.toThrow('NEWS_INVALID_QUERY');
  await expect(
    new MarketauxNews('', new NewsTransport(fetcher)).fetchPage(query('marketaux'), signal()),
  ).rejects.toThrow('NEWS_AUTH_FAILED');
  expect(fetcher).not.toHaveBeenCalled();
});
it('classifies HTTP failures, honors Retry-After, and never retries or exposes error bodies', async () => {
  for (const [status, code] of [
    [401, 'NEWS_AUTH_FAILED'],
    [403, 'NEWS_ACCESS_DENIED'],
    [402, 'NEWS_PROVIDER_EXHAUSTED'],
    [400, 'NEWS_INVALID_QUERY'],
    [429, 'NEWS_RATE_LIMITED'],
    [503, 'NEWS_PROVIDER_UNAVAILABLE'],
  ] as const) {
    const fetcher = vi.fn(
      async () =>
        new Response('private-key provider body', { status, headers: { 'Retry-After': '120' } }),
    );
    const transport = new NewsTransport(fetcher, () => now);
    try {
      await transport.json(
        'marketaux',
        new URLSearchParams({ api_token: 'private-key' }),
        {},
        signal(),
      );
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(NewsError);
      expect((e as NewsError).code).toBe(code);
      expect((e as NewsError).retryAt).toBe(now + 120000);
      expect(String(e)).not.toContain('private-key');
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
  expect(retryAfter(new Date(now + 60000).toUTCString(), now)).toBe(now + 60000);
  expect(retryAfter('bad-date', now)).toBeNull();
});
it('bounds response bytes even without Content-Length and treats invalid JSON safely', async () => {
  for (const response of [
    new Response('x'.repeat(NEWS_LIMITS.responseBytes + 1)),
    new Response('{}', { headers: { 'Content-Length': String(NEWS_LIMITS.responseBytes + 1) } }),
  ]) {
    const transport = new NewsTransport(async () => response);
    await expect(transport.json('gdelt', new URLSearchParams(), {}, signal())).rejects.toThrow(
      'NEWS_RESPONSE_TOO_LARGE',
    );
  }
  await expect(
    new NewsTransport(async () => new Response('private body')).json(
      'gdelt',
      new URLSearchParams(),
      {},
      signal(),
    ),
  ).rejects.toThrow('NEWS_INVALID_RESPONSE');
});
it('bounds both request time and stalled body reads, including an already-aborted signal', async () => {
  const pendingFetch = vi.fn(() => new Promise<Response>(() => {}));
  await expect(
    new NewsTransport(pendingFetch, () => now, 5).json(
      'gdelt',
      new URLSearchParams(),
      {},
      signal(),
    ),
  ).rejects.toThrow('NEWS_TIMEOUT');
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel: cancelled,
  });
  await expect(
    new NewsTransport(
      async () => new Response(body),
      () => now,
      5,
    ).json('gdelt', new URLSearchParams(), {}, signal()),
  ).rejects.toThrow('NEWS_TIMEOUT');
  expect(cancelled).toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  const unused = vi.fn(async () => Response.json({}));
  await expect(
    new NewsTransport(unused).json('gdelt', new URLSearchParams(), {}, controller.signal),
  ).rejects.toThrow('NEWS_TIMEOUT');
  expect(unused).not.toHaveBeenCalled();
});
it('does not infer remaining quota from limit headers', async () => {
  const transport = new NewsTransport(async () =>
    Response.json({}, { headers: { 'X-UsageLimit-Limit': '100' } }),
  );
  expect(
    (await transport.json('marketaux', new URLSearchParams(), {}, signal())).quota.remaining,
  ).toBeNull();
});
it('preserves exhaustion headers when provider JSON validation fails', async () => {
  const adapter = new CurrentsNews(
    'private-key',
    new NewsTransport(
      async () =>
        Response.json(
          { status: 'error' },
          { headers: { 'X-RateLimit-Remaining': '0', 'Retry-After': '120' } },
        ),
      () => now,
    ),
  );
  try {
    await adapter.fetchPage(query('currents'), signal());
    throw new Error('expected failure');
  } catch (e) {
    expect(e).toBeInstanceOf(NewsError);
    expect((e as NewsError).remaining).toBe(0);
    expect((e as NewsError).retryAt).toBe(now + 120000);
  }
});
