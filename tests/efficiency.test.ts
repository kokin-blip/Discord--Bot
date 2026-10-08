import { expect, it, vi } from 'vitest';
import { Store } from '../src/storage.js';
import { DataService } from '../src/data.js';
import { fixture } from './fixtures.js';
import { crypto, benchmarkFor, type MarketDataProvider } from '../src/domain.js';
import { QUARTER } from '../src/core/time.js';
import { ChartCache } from '../src/chart-cache.js';
import { explain } from '../src/insights.js';
import { detect } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';

it('keeps warm crypto incremental and saves it despite failure of a cold product', async () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    const warm = crypto('BTC-USD'),
      cold = crypto('SOL-USD');
    const last = data.intraday[0]!;
    store.cache(warm, '15m', [last]);
    const calls: { symbol: string; start: number }[] = [];
    const provider = {
      bars: async (list: any[], _interval: string, start: number) => {
        calls.push({ symbol: list[0].symbol, start });
        if (list[0].id === cold.id) throw new Error('PROVIDER_RETRY_LATER');
        return new Map([
          [warm.id, [{ ...last, start: last.start + QUARTER, end: last.end + QUARTER }]],
        ]);
      },
    } as unknown as MarketDataProvider;
    await new DataService(store, provider, provider).refreshIntraday(
      [warm, cold],
      last.end + QUARTER,
    );
    expect(calls[0]?.start).toBe(last.start - QUARTER);
    expect(calls[1]!.start).toBeLessThan(last.start - 30 * 86400000);
    expect(store.bars(warm, '15m').at(-1)?.end).toBe(last.end + QUARTER);
    expect(store.get(`refresh_error:${cold.id}:15m`, null)).not.toBeNull();
  } finally {
    store.close();
  }
});
it('caches identical charts and retries failures without consuming duplicate renders', async () => {
  const cache = new ChartCache();
  const render = vi.fn(async () => Buffer.from('chart'));
  const data = fixture();
  await Promise.all([
    cache.render(data, undefined, undefined, render, 0),
    cache.render(data, undefined, undefined, render, 0),
  ]);
  await cache.render(data, undefined, undefined, render, 10);
  expect(render).toHaveBeenCalledTimes(1);
  await cache.render(data, undefined, undefined, render, 900001);
  expect(render).toHaveBeenCalledTimes(2);
  const failed = vi.fn(async () => {
    throw new Error('render');
  });
  await expect(cache.render(data, undefined, { id: 'different' } as any, failed)).rejects.toThrow();
  await expect(cache.render(data, undefined, { id: 'different' } as any, failed)).rejects.toThrow();
  expect(failed).toHaveBeenCalledTimes(2);
});
it('uses detector checks to explain rejected volume and does not claim a qualification', () => {
  const store = new Store(':memory:');
  try {
    const data = fixture();
    store.cache(data.instrument, '1d', data.daily);
    store.cache(benchmarkFor(data.instrument), '1d', data.benchmark);
    store.saveStrategy({ ...defaults, breakoutVolume: 5 });
    const result = explain(store, data.instrument, data.provenance.asOf);
    expect(result.candidates).toHaveLength(0);
    expect(detect(data, store.strategy(), data.provenance.asOf)).toHaveLength(0);
    expect(
      result.attempts.some((a) => a?.checks.some((c) => c.name === 'Relative volume' && !c.passed)),
    ).toBe(true);
  } finally {
    store.close();
  }
});
it('isolates dead deliveries for operator retry and retains successful receipts', () => {
  const store = new Store(':memory:');
  try {
    store.pin(crypto('ETH-USD'));
    const item = store.pending(Date.now())[0]!;
    store.saveReceipt(item.event.id, 'channel', 'message');
    for (let n = 0; n < 10; n++) store.failed(item.event.id, Date.now(), n, 'DELIVERY_FAILED');
    expect(store.pendingCount()).toBe(0);
    expect(store.queueStatus(Date.now())[0]?.reviewRequired).toBe(true);
    store.retryDelivery(item.event.id);
    expect(store.pendingCount()).toBe(1);
    expect(store.receipt(item.event.id, 'channel')).toBe('message');
  } finally {
    store.close();
  }
});

it('releases the provider work limit after a job so later member commands can fetch', async () => {
  const { HttpClient } = await import('../src/adapters/http.js');
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    const client = new HttpClient(undefined, fetcher, async () => {});
    client.beginWork();
    await client.json('https://example.com');
    vi.advanceTimersByTime(30000);
    await expect(client.json('https://example.com')).rejects.toThrow('PROVIDER_WORK_LIMIT');
    client.endWork();
    await expect(client.json('https://example.com')).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
