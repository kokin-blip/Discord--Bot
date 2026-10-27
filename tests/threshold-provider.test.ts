import { expect, it, vi } from 'vitest';
import { Alpaca } from '../src/adapters/alpaca.js';
import { HttpClient } from '../src/adapters/http.js';
import { Store } from '../src/storage.js';
import { contract, open, thresholdFixture, mature } from './threshold-fixtures.js';

it('requests exact deduplicated contracts on the indicative multi-quote endpoint without substituting missing contracts', async () => {
  const fetcher = vi.fn(async (input: URL | string | Request) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/v1beta1/options/quotes/latest');
    expect(url.searchParams.get('feed')).toBe('indicative');
    expect(url.searchParams.get('symbols')).toBe(`${contract},AAPL261218P00100000`);
    return Response.json({
      quotes: {
        [contract]: { bp: 2, ap: 2.02, bs: 10, as: 20, t: new Date(open).toISOString() },
        NEARBY: { bp: 3, ap: 3.01, bs: 1, as: 1, t: new Date(open).toISOString() },
      },
    });
  });
  const provider = new Alpaca(
    new HttpClient(undefined, fetcher as typeof fetch, async () => {}),
    'synthetic',
    'synthetic',
  );
  const result = await provider.optionQuotes([contract, contract, 'AAPL261218P00100000'], open);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result).toEqual([
    { contract, bid: 2, ask: 2.02, bidSize: 10, askSize: 20, asOf: open, feed: 'indicative' },
  ]);
});
it('bounds option retries at two attempts and retains persisted HTTP cooldown/accounting', async () => {
  const store = new Store(':memory:');
  try {
    const fetcher = vi.fn(async () =>
      Response.json({}, { status: 429, headers: { 'retry-after': '0' } }),
    );
    const http = new HttpClient(store, fetcher as typeof fetch, async () => {});
    http.beginWork();
    await expect(
      new Alpaca(http, 'synthetic', 'synthetic').optionQuotes([contract], open),
    ).rejects.toThrow('DATA_HTTP_429');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.get<{ requests: number }>('provider_usage', { requests: 0 }).requests).toBe(2);
    expect(store.get('retry_after:data.alpaca.markets', 0)).toBeGreaterThan(0);
  } finally {
    store.close();
  }
});
it('does not reset the existing shared request window and rejects batches above twenty', async () => {
  const fetcher = vi.fn(async () => Response.json({}));
  const http = new HttpClient(undefined, fetcher as typeof fetch, async () => {}),
    provider = new Alpaca(http, 'synthetic', 'synthetic');
  http.beginWork();
  for (let n = 0; n < 24; n++) await http.json('https://data.alpaca.markets/synthetic');
  await expect(provider.optionQuotes([contract], open)).rejects.toThrow('PROVIDER_WORK_LIMIT');
  expect(fetcher).toHaveBeenCalledTimes(24);
  await expect(
    provider.optionQuotes(
      Array.from({ length: 21 }, (_, n) => `AAPL261218C${String(100000 + n).padStart(8, '0')}`),
      open,
    ),
  ).rejects.toThrow('BATCH_LIMIT');
});
it('handles twenty registered monitors with a single bounded quote batch and no chart work', async () => {
  const f = thresholdFixture();
  try {
    for (let n = 0; n < 20; n++)
      f.add(`user${n}`, { contract: `AAPL261218C${String(100000 + n * 1000).padStart(8, '0')}` });
    await f.tick(open);
    await f.tick(mature);
    expect(f.optionQuotes).toHaveBeenCalledTimes(2);
    expect(f.optionQuotes.mock.calls[1]![0]).toHaveLength(20);
    expect(f.pending()).toHaveLength(20);
    expect(f.store.get<{ requests: number }>('provider_usage', { requests: 0 }).requests).toBe(0); // provider is synthetic; no live requests
  } finally {
    f.store.close();
  }
});
