import type { Bar, Candidate, Dataset, Direction, Idea } from '../src/domain.js';
import { crypto } from '../src/domain.js';
import { DAY, QUARTER, weeklyBars } from '../src/core/time.js';
import { defaults } from '../src/config.js';
import { detect } from '../src/core/strategy.js';
export function fixture(direction: Direction = 'bullish', offset = 0): Dataset {
  const start = Date.parse('2023-01-02T00:00:00Z') + offset * 7 * DAY;
  const daily: Bar[] = Array.from({ length: 420 }, (_, i) => {
    const close = i < 364 ? 90 + i * 0.025 : 100.2 + (i - 364) * 0.07;
    return {
      start: start + i * DAY,
      end: start + (i + 1) * DAY,
      open: close - 0.1,
      close,
      high: i < 364 ? close + 2 : i < 385 ? 110 : close + 1,
      low: i < 364 ? close - 2 : i < 385 ? 100 : close - 1,
      volume: 1000,
    };
  });
  const breakout: Bar = {
    start: start + 420 * DAY,
    end: start + 421 * DAY,
    open: 109,
    high: 114,
    low: 108,
    close: 112,
    volume: 2000,
  };
  const retest: Bar = {
    start: breakout.end,
    end: breakout.end + DAY,
    open: 110.2,
    high: 112,
    low: 110,
    close: 111.2,
    volume: 500,
  };
  daily.push(breakout, retest);
  const benchmark: Bar[] = daily.map((b, i) => ({
    ...b,
    open: 80 + i * 0.02,
    close: 80 + i * 0.02,
    high: 81 + i * 0.02,
    low: 79 + i * 0.02,
  }));
  const intraday: Bar[] = [
    {
      start: retest.end,
      end: retest.end + QUARTER,
      open: 111.2,
      high: 112.6,
      low: 111,
      close: 112.5,
      volume: 30,
    },
  ];
  if (direction === 'bearish')
    for (const b of [...daily, ...benchmark, ...intraday]) {
      const old = { ...b };
      b.open = 200 - old.open;
      b.close = 200 - old.close;
      b.high = 200 - old.low;
      b.low = 200 - old.high;
    }
  const now = intraday[0]!.end;
  return {
    instrument: crypto('ETH-USD'),
    daily,
    weekly: weeklyBars(daily, 'crypto', [], now),
    intraday,
    benchmark,
    sessions: [],
    provenance: {
      provider: 'synthetic fixture',
      feed: 'synthetic, not historical evidence',
      delayMinutes: 0,
      asOf: now,
    },
  };
}
export function candidate(data = fixture()): Candidate {
  const found = detect(data, defaults, data.provenance.asOf);
  if (!found.length) throw new Error('Fixture has no qualifying candidate');
  return found.at(-1)!;
}
export function idea(data = fixture()): Idea {
  const c = candidate(data);
  return {
    candidate: c,
    state: 'watching',
    lastBar: c.retest!.end,
    milestones: [],
    createdAt: data.provenance.asOf,
  };
}
