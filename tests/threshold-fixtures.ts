import { vi } from 'vitest';
import { Store } from '../src/storage.js';
import { equity, type Dataset, type Session, type Idea } from '../src/domain.js';
import { DAY, QUARTER } from '../src/core/time.js';
import { nyTime } from '../src/adapters/alpaca.js';
import { ThresholdStore } from '../src/threshold/store.js';
import { ThresholdEngine } from '../src/threshold/engine.js';
import type { OptionQuote } from '../src/threshold/types.js';
import type { DataService } from '../src/data.js';
import { fixture, candidate } from './fixtures.js';

export const open = nyTime('2026-10-20', '09:30');
export const mature = nyTime('2026-10-20', '13:50');
export const contract = 'AAPL261218C00100000';
export function thresholdFixture(path = ':memory:') {
  const store = new Store(path),
    state = new ThresholdStore(store);
  const sessions: Session[] = [];
  for (
    let d = Date.parse('2026-09-01T00:00:00Z');
    d <= Date.parse('2026-12-21T00:00:00Z');
    d += DAY
  ) {
    if ([0, 6].includes(new Date(d).getUTCDay())) continue;
    const date = new Date(d).toISOString().slice(0, 10);
    sessions.push({ date, open: nyTime(date, '09:30'), close: nyTime(date, '16:00') });
  }
  const instrument = equity('AAPL');
  const bars = sessions
    .filter((s) => s.date <= '2026-10-20')
    .flatMap((s) =>
      Array.from({ length: 26 }, (_, n) => ({
        start: s.open + n * QUARTER,
        end: s.open + (n + 1) * QUARTER,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 100,
      })),
    );
  const daily = Array.from({ length: 260 }, (_, n) => ({
    start: open - (261 - n) * DAY,
    end: open - (260 - n) * DAY,
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 10000,
  }));
  store.set('calendar', { day: '2026-10-20', rows: sessions });
  store.pin(instrument);
  state.configure({ enabled: true, ideas: true, contracts: true }, 'admin', open - 60000);
  let bid = 2,
    quotePatch: Partial<OptionQuote> = {};
  const quote = (now: number): OptionQuote => ({
    contract,
    bid,
    ask: bid + 0.02,
    bidSize: 1000,
    askSize: 1000,
    asOf: now,
    feed: 'indicative',
    ...quotePatch,
  });
  const optionQuotes = vi.fn(async (symbols: string[], now: number) =>
    symbols.map((symbol) => ({ ...quote(now), contract: symbol })),
  );
  const provider = { equities: { optionQuotes } } as unknown as DataService;
  const engine = new ThresholdEngine(store, provider, () => 0);
  const dataset = (now: number): Dataset => ({
    instrument,
    daily,
    weekly: [],
    benchmark: daily,
    sessions,
    intraday: bars.filter((b) => b.end <= now - 16 * 60000),
    provenance: {
      provider: 'Synthetic Alpaca',
      feed: 'synthetic delayed',
      delayMinutes: 16,
      asOf: now - 16 * 60000,
    },
  });
  const cache = (now: number) => {
    const d = dataset(now);
    store.cache(instrument, '1d', daily);
    store.cache(instrument, '15m', d.intraday);
    return d;
  };
  const add = (owner = 'alice', values: Partial<Parameters<ThresholdStore['register']>[0]> = {}) =>
    state.register({ contract, entry: 2, stop: 1.5, ...values }, owner, open);
  const tick = async (now: number, continuous = true) => {
    // Other tests exercise interruptions explicitly. Simulate intermediate healthy polls here.
    if (continuous)
      for (const m of state.all()) {
        if (m.lastEvaluated) {
          m.lastEvaluated = now - 300000;
          state.save(m);
        }
      }
    const d = cache(now);
    await engine.poll(new Map([[instrument.id, d]]), now);
    return d;
  };
  const pending = (now = mature) =>
    store.pending(now).filter((p) => p.event.kind === 'threshold_alert');
  const autoIdea = (direction: 'bullish' | 'bearish' = 'bullish'): Idea => {
    const c = candidate(fixture(direction));
    Object.assign(c, {
      instrument,
      direction,
      entry: 100,
      level: direction === 'bullish' ? 98 : 102,
      confirmedAt: open,
    });
    const i: Idea = {
      candidate: c,
      state: 'entry_triggered',
      createdAt: open,
      lastBar: open,
      milestones: [],
    };
    store.saveIdea(i, [], false);
    return i;
  };
  return {
    store,
    state,
    engine,
    instrument,
    sessions,
    bars,
    daily,
    provider,
    optionQuotes,
    quote,
    dataset,
    cache,
    add,
    tick,
    pending,
    autoIdea,
    setBid: (value: number) => {
      bid = value;
    },
    setQuote: (patch: Partial<OptionQuote>) => {
      quotePatch = patch;
    },
  };
}
