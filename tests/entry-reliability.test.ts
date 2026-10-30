import { it, expect, vi } from 'vitest';
import { Store } from '../src/storage.js';
import { DataService } from '../src/data.js';
import { Coinbase } from '../src/adapters/coinbase.js';
import { HttpClient } from '../src/adapters/http.js';
import { crypto, equity, type Bar, type MarketDataProvider } from '../src/domain.js';
import { QUARTER, DAY } from '../src/core/time.js';
import { scheduleRepair, repairHistory, repairReport } from '../src/history-repair.js';
import { observeSource, sourceObservedAt, timingReport } from '../src/entry-research/timing.js';
import { fixture, idea } from './fixtures.js';
import { advance } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';

const now = () => Math.floor(Date.now() / QUARTER) * QUARTER;
const bar = (start: number): Bar => ({
  start,
  end: start + QUARTER,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
});
it('repairs an old hole behind a fresh latest candle without a market-data call from diagnostics', async () => {
  const s = new Store(':memory:');
  try {
    const t = now(),
      i = crypto('BTC-USD');
    s.cache(i, '15m', [bar(t - 3 * QUARTER), bar(t - QUARTER)]);
    const page = vi.fn(async () => ({ bars: [bar(t - 2 * QUARTER)] }));
    const provider = {
      barPage: page,
      bars: vi.fn(),
      calendar: async () => [],
    } as unknown as MarketDataProvider;
    const data = new DataService(s, provider, provider);
    await data.refreshIntraday([i], t);
    expect(provider.bars).not.toHaveBeenCalled();
    expect(repairReport(s).pending).toBe(1);
    await data.repair(t);
    expect(page).toHaveBeenCalledTimes(1);
    expect(s.bars(i, '15m')).toHaveLength(3);
    scheduleRepair(s, i, '15m', [], t);
    expect(repairReport(s).pending).toBe(0);
  } finally {
    s.close();
  }
});
it('bounds repair pages, resumes provider pagination, and preserves retry-after across instances', async () => {
  const s = new Store(':memory:');
  try {
    const t = now(),
      instruments = ['BTC-USD', 'ETH-USD', 'SOL-USD'].map(crypto);
    for (const i of instruments) {
      s.cache(i, '15m', [bar(t - 3 * QUARTER), bar(t - QUARTER)]);
      scheduleRepair(s, i, '15m', [], t);
    }
    const page = vi.fn(async (_i: unknown, _interval: unknown, from: number) => ({
      bars: [bar(from)],
      next: 'page-two',
    }));
    const p = { barPage: page } as unknown as MarketDataProvider;
    await repairHistory(s, () => p, t, 100);
    expect(page).toHaveBeenCalledTimes(2);
    expect(repairReport(s).jobs.filter((j) => j.cursor === 'page-two')).toHaveLength(2);
    page.mockImplementation(async () => {
      throw new Error('PROVIDER_RETRY_LATER');
    });
    s.set('retry_after:api.exchange.coinbase.com', t + DAY);
    await repairHistory(s, () => p, t + 1);
    const retry = repairReport(s).jobs.find((j) => j.error === 'PROVIDER_RETRY_LATER')!;
    expect(retry.nextAttempt).toBe(t + DAY);
    expect(retry.cursor).toBe('page-two');
  } finally {
    s.close();
  }
});
it('leaves provider gaps unavailable, never fabricates a candle, and backs off repeated empty results', async () => {
  const s = new Store(':memory:');
  try {
    const t = now(),
      i = crypto('BTC-USD');
    s.cache(i, '15m', [bar(t - 3 * QUARTER), bar(t - QUARTER)]);
    scheduleRepair(s, i, '15m', [], t);
    const p = { barPage: vi.fn(async () => ({ bars: [] })) } as unknown as MarketDataProvider;
    await repairHistory(s, () => p, t);
    expect(repairReport(s).unavailable).toBe(1);
    expect(s.bars(i, '15m')).toHaveLength(2);
    scheduleRepair(s, i, '15m', [], t + 1);
    await repairHistory(s, () => p, t + 1);
    expect(p.barPage).toHaveBeenCalledTimes(1);
  } finally {
    s.close();
  }
});
it('does not request weekend, holiday, or early-close equity candles as missing', () => {
  const s = new Store(':memory:');
  try {
    const i = equity('TEST'),
      open = Date.parse('2026-11-27T14:30:00Z'),
      close = Date.parse('2026-11-27T18:00:00Z');
    const sessions = [{ date: '2026-11-27', open, close }];
    s.cache(
      i,
      '15m',
      Array.from({ length: 14 }, (_, n) => bar(open + n * QUARTER)),
    );
    scheduleRepair(s, i, '15m', sessions, Date.parse('2026-11-29T22:00:00Z'));
    expect(repairReport(s).jobs).toHaveLength(0);
  } finally {
    s.close();
  }
});
it('saves successful Coinbase pages before a subsequent failure and resumes from cached progress', async () => {
  const s = new Store(':memory:');
  try {
    const t = now();
    let fail = true;
    const starts: number[] = [];
    const http = new HttpClient(
      undefined,
      async (input) => {
        const u = new URL(String(input)),
          start = Date.parse(u.searchParams.get('start')!),
          end = Date.parse(u.searchParams.get('end')!);
        starts.push(start);
        if (fail && starts.length === 2)
          return Response.json({ message: 'unavailable' }, { status: 400 });
        return Response.json(
          Array.from({ length: Math.floor((end - start) / QUARTER) }, (_, n) => [
            (start + n * QUARTER) / 1000,
            99,
            101,
            100,
            100,
            1,
          ]),
        );
      },
      async () => {},
    );
    const coinbase = new Coinbase(http),
      data = new DataService(s, coinbase, coinbase),
      i = crypto('BTC-USD');
    await expect(
      coinbase.bars([i], '15m', t - 35 * DAY, t, (instrument, bars) =>
        s.cache(instrument, '15m', bars),
      ),
    ).rejects.toThrow();
    expect(s.bars(i, '15m')).toHaveLength(299);
    const latest = s.bars(i, '15m').at(-1)!.start;
    fail = false;
    const before = starts.length;
    await data.refreshIntraday([i], t);
    expect(starts[before]).toBeGreaterThan(latest);
    expect(starts[before]).toBeGreaterThanOrEqual(t - 3 * QUARTER);
    expect(s.bars(i, '15m').at(-1)!.end).toBe(t);
  } finally {
    s.close();
  }
});
it('retains first source and delivery observations without inventing legacy timestamps', () => {
  const s = new Store(':memory:');
  try {
    const t = now(),
      i = crypto('BTC-USD'),
      b = bar(t - QUARTER);
    expect(sourceObservedAt(s, i, t)).toBeUndefined();
    observeSource(s, i, '15m', [b], t);
    observeSource(s, i, '15m', [b], t + 1000);
    expect(sourceObservedAt(s, i, t)).toBe(t);
    const d = fixture(),
      r = advance(idea(d), d, defaults, d.provenance.asOf),
      e = r.events.at(-1)!;
    s.saveIdea(r.idea, [e]);
    s.saveReceipt(e.id, 'entries', 'message');
    const first = s.db.prepare('SELECT * FROM delivery_timings').get();
    s.saveReceipt(e.id, 'entries', 'different');
    expect(s.db.prepare('SELECT * FROM delivery_timings').get()).toEqual(first);
    expect(s.receipt(e.id, 'entries')).toBe('message');
    expect(timingReport(s)).toMatchObject({ events: 1, deliveries: 1, observedSources: 0 });
  } finally {
    s.close();
  }
});
