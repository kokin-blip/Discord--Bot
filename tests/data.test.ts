import { Store } from '../src/storage.js';
import { expect, it, vi } from 'vitest';
import { nyTime, Alpaca } from '../src/adapters/alpaca.js';
import { HttpClient } from '../src/adapters/http.js';
import { checkDaily, checkIntraday, historyChanged } from '../src/core/quality.js';
import { DAY, QUARTER, weeklyBars } from '../src/core/time.js';
import { fixture } from './fixtures.js';
import { equity } from '../src/domain.js';
import { crypto } from '../src/domain.js';
import { Coinbase } from '../src/adapters/coinbase.js';
it('identifies Coinbase requests with a User-Agent in runtimes that do not supply one', async () => {
  const paths: string[] = [];
  const http = new HttpClient(
    undefined,
    async (input, init) => {
      if (!new Headers(init?.headers).get('User-Agent'))
        return Response.json({ message: 'User-Agent header is required.' }, { status: 400 });
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === '/products')
        return Response.json([
          {
            id: 'BTC-USD',
            quote_currency: 'USD',
            base_currency: 'BTC',
            status: 'online',
          },
        ]);
      return Response.json([]);
    },
    async () => {},
  );
  const provider = new Coinbase(http);
  expect(await provider.discover()).toEqual([crypto('BTC-USD')]);
  const now = Date.parse('2026-10-06T00:00:00Z');
  await provider.bars([crypto('BTC-USD')], '1d', now - DAY, now);
  await provider.bars([crypto('BTC-USD')], '15m', now - QUARTER, now);
  expect(paths).toEqual(['/products', '/products/BTC-USD/candles', '/products/BTC-USD/candles']);
});
it('records safe Coinbase rejection details without retaining arbitrary response text', async () => {
  const store = new Store(':memory:');
  try {
    const http = new HttpClient(store, async () =>
      Response.json(
        {
          message: 'granularity too large, maximum 300 candles; private-token',
        },
        { status: 400 },
      ),
    );
    const url =
      'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=2024-07-28T00:00:00Z&end=2025-05-23T00:00:00Z';
    await expect(http.json(url)).rejects.toThrow('DATA_HTTP_400');
    const saved = store.get('coinbase_error', {});
    expect(saved).toMatchObject({
      status: 400,
      reason: 'CANDLE_LIMIT',
      product: 'BTC-USD',
      granularity: 86400,
    });
    expect(JSON.stringify(saved)).not.toContain('private-token');
  } finally {
    store.close();
  }
});
it('paginates Coinbase history within its candle limit and excludes incomplete candles', async () => {
  const now = Date.parse('2026-10-06T20:06:59Z');
  const urls: URL[] = [];
  const http = new HttpClient(
    undefined,
    async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      const start = Date.parse(url.searchParams.get('start')!);
      const end = Date.parse(url.searchParams.get('end')!);
      const rows = [];
      for (let t = start; t <= end; t += DAY) rows.push([t / 1000, 9, 11, 10, 10, 100]);
      return Response.json(rows.reverse());
    },
    async () => {},
  );
  const rows = (await new Coinbase(http).bars([crypto('BTC-USD')], '1d', now - 800 * DAY, now)).get(
    crypto('BTC-USD').id,
  )!;
  expect(urls).toHaveLength(3);
  expect(
    urls.every(
      (url) =>
        (Date.parse(url.searchParams.get('end')!) - Date.parse(url.searchParams.get('start')!)) /
          DAY <=
        299,
    ),
  ).toBe(true);
  expect(rows).toHaveLength(799);
  expect(rows.every((b) => b.end <= Math.floor(now / DAY) * DAY)).toBe(true);
  expect(new Set(rows.map((b) => b.start)).size).toBe(rows.length);
});
it('binds the default fetch to the global receiver required by Workers', async () => {
  vi.stubGlobal('fetch', function (this: unknown) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(Response.json({ ok: true }));
  });
  try {
    expect(await new HttpClient().json('https://example.test')).toEqual({ ok: true });
  } finally {
    vi.unstubAllGlobals();
  }
});
it('handles New York daylight saving and early closes', () => {
  expect(new Date(nyTime('2026-01-05', '09:30')).toISOString()).toBe('2026-01-05T14:30:00.000Z');
  expect(new Date(nyTime('2026-07-06', '09:30')).toISOString()).toBe('2026-07-06T13:30:00.000Z');
  expect(new Date(nyTime('2026-11-27', '13:00')).toISOString()).toBe('2026-11-27T18:00:00.000Z');
});
it('rejects missing crypto daily candles and revised prices', () => {
  const d = fixture();
  expect(() => checkDaily(d.instrument, d.daily, [], d.daily.at(-1)!.end)).not.toThrow();
  const broken = d.daily.filter((_, i) => i !== 400);
  expect(() => checkDaily(d.instrument, broken, [], d.daily.at(-1)!.end)).toThrow('MISSING');
  expect(historyChanged(d.daily, [{ ...d.daily[0]!, close: 80 }])).toBe(true);
});
it('only aggregates complete Monday-start UTC weeks', () => {
  const d = fixture();
  const w = weeklyBars(d.daily, 'crypto', [], d.daily.at(-1)!.start);
  expect(w.every((b) => new Date(b.start).getUTCDay() === 1)).toBe(true);
  expect(w.every((b) => b.end <= d.daily.at(-1)!.start)).toBe(true);
});
it('accepts exchange holidays and early-close weekly aggregation', () => {
  const start = Date.parse('2026-11-23T00:00:00Z');
  const dates = [0, 1, 2, 4];
  const sessions = dates.map((n) => ({
    date: new Date(start + n * DAY).toISOString().slice(0, 10),
    open: start + n * DAY + 14.5 * 3600000,
    close: start + n * DAY + (n === 4 ? 18 : 21) * 3600000,
  }));
  const daily = dates.map((n) => ({
    start: start + n * DAY,
    end: sessions.find((s) => s.date === new Date(start + n * DAY).toISOString().slice(0, 10))!
      .close,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 1,
  }));
  expect(weeklyBars(daily, 'equity', sessions, sessions.at(-1)!.close)).toHaveLength(1);
});
it('fails closed on missing intraday history', () => {
  const d = fixture();
  expect(() => checkIntraday(d, d.intraday[0]!.start, d.intraday[0]!.end + QUARTER)).toThrow(
    'MISSING',
  );
});
it('honors Retry-After and keeps credentials out of errors', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const http = new HttpClient(
    undefined,
    async () =>
      ++calls === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
        : Response.json({ ok: true }),
    async (ms) => {
      sleeps.push(ms);
    },
  );
  expect(await http.json('https://example.test')).toEqual({ ok: true });
  expect(sleeps).toContain(2000);
  const bad = new HttpClient(undefined, async () => new Response('secret', { status: 403 }));
  await expect(bad.json('https://example.test')).rejects.toThrow('DATA_HTTP_403');
});
it('uses delayed SIP, paginates and filters extended hours', async () => {
  const urls: string[] = [];
  const http = new HttpClient(
    undefined,
    async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/calendar'))
        return Response.json([{ date: '2026-07-06', open: '09:30', close: '16:00' }]);
      return Response.json({
        bars: {
          AAPL: [
            { t: '2026-07-06T13:30:00Z', o: 100, h: 101, l: 99, c: 100, v: 20 },
            { t: '2026-07-06T12:00:00Z', o: 100, h: 101, l: 99, c: 100, v: 20 },
          ],
        },
        next_page_token: urls.filter((u) => u.includes('/bars')).length === 1 ? 'next' : null,
      });
    },
    async () => {},
  );
  const provider = new Alpaca(http, 'key', 'secret'),
    now = Date.parse('2026-07-06T15:00:00Z'),
    bars = await provider.bars([equity('AAPL')], '15m', now - DAY, now);
  expect(bars.get(equity('AAPL').id)).toHaveLength(2);
  expect(urls.filter((u) => u.includes('/bars'))).toHaveLength(2);
  const request = new URL(urls.find((u) => u.includes('/bars'))!);
  expect(request.searchParams.get('feed')).toBe('sip');
  expect(Date.parse(request.searchParams.get('end')!)).toBe(now - 16 * 60000);
});
it('persists long Retry-After instructions without retrying prematurely', async () => {
  const store = new Store(':memory:');
  try {
    let calls = 0;
    const client = new HttpClient(
      store,
      async () => {
        calls++;
        return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
      },
      async () => {},
    );
    await expect(client.json('https://api.exchange.coinbase.com/time')).rejects.toThrow(
      'PROVIDER_RETRY_LATER',
    );
    await expect(client.json('https://api.exchange.coinbase.com/time')).rejects.toThrow(
      'PROVIDER_RETRY_LATER',
    );
    expect(calls).toBe(1);
  } finally {
    store.close();
  }
});
