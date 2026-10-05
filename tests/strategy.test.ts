import { describe, it, expect } from 'vitest';
import { fixture, candidate, idea } from './fixtures.js';
import { advance, detect, rank, targetFor, strategyVersion } from '../src/core/strategy.js';
import { defaults, strategySchema } from '../src/config.js';
import { DAY, QUARTER } from '../src/core/time.js';
import { atr } from '../src/core/indicators.js';
describe.each(['bullish', 'bearish'] as const)('%s breakout/retest', (direction) => {
  it('qualifies and confirms mirrored entries with 3R room', () => {
    const data = fixture(direction),
      c = candidate(data);
    expect(c.direction).toBe(direction);
    expect(c.retest).toBeDefined();
    const r = advance(idea(data), data, defaults, data.provenance.asOf);
    expect(r.events.map((e) => e.state)).toEqual(['setup_ready', 'entry_triggered']);
    expect(r.idea.candidate.targets).toHaveLength(3);
  });
  it('rejects insufficient breakout volume', () => {
    const d = fixture(direction);
    d.daily.at(-2)!.volume = 100;
    expect(detect(d, defaults, d.provenance.asOf)).toHaveLength(0);
  });
  it('does not qualify a retest on high volume', () => {
    const d = fixture(direction);
    d.daily.at(-1)!.volume = 1500;
    expect(candidate(d).retest).toBeUndefined();
  });
  it('ignores incomplete breakout candles', () => {
    const d = fixture(direction);
    expect(detect(d, defaults, d.daily.at(-2)!.start)).toHaveLength(0);
  });
  it('ignores incomplete confirmation candles', () => {
    const d = fixture(direction);
    expect(
      advance(idea(d), d, defaults, d.intraday[0]!.start).idea.candidate.entry,
    ).toBeUndefined();
  });
  it('rejects an extended entry', () => {
    const d = fixture(direction),
      i = idea(d),
      c = i.candidate;
    d.intraday[0]!.close = c.level + (direction === 'bullish' ? 1 : -1) * 2 * c.atr;
    d.intraday[0]!.high = Math.max(d.intraday[0]!.high, d.intraday[0]!.close);
    d.intraday[0]!.low = Math.min(d.intraday[0]!.low, d.intraday[0]!.close);
    expect(advance(i, d, defaults, d.provenance.asOf).idea.state).toBe('expired');
  });
  it('invalidates on a close through the level and records target ambiguity', () => {
    const d = fixture(direction),
      entered = advance(idea(d), d, defaults, d.provenance.asOf).idea,
      c = entered.candidate,
      s = direction === 'bullish' ? 1 : -1;
    const b = {
      ...d.intraday[0]!,
      start: d.provenance.asOf,
      end: d.provenance.asOf + QUARTER,
      close: c.level - s,
      high: Math.max(c.targets![2]! + 1, c.entry! + 1),
      low: Math.min(c.targets![2]! - 1, c.entry! - 1),
    };
    d.intraday.push(b);
    const r = advance(entered, d, defaults, b.end);
    expect(r.idea.state).toBe('invalidated');
    expect(r.events[0]!.observations![0]).toContain('ordering unknown');
    expect(r.events.some((e) => e.state === 'final_target')).toBe(false);
  });
  it('does not count entry candle target touches', () => {
    const d = fixture(direction);
    if (direction === 'bullish') d.intraday[0]!.high = 140;
    else d.intraday[0]!.low = 60;
    const r = advance(idea(d), d, defaults, d.provenance.asOf);
    expect(r.events.some((e) => e.state === 'final_target')).toBe(false);
  });
  it('expires an unconfirmed retest after two days', () => {
    const d = fixture(direction);
    d.intraday = [];
    expect(advance(idea(d), d, defaults, d.daily.at(-1)!.end + 2 * DAY).idea.state).toBe('expired');
  });
  it('marks final target without claiming a fill', () => {
    const d = fixture(direction),
      r = advance(idea(d), d, defaults, d.provenance.asOf),
      s = direction === 'bullish' ? 1 : -1;
    const b = { ...d.intraday[0]!, start: d.provenance.asOf, end: d.provenance.asOf + QUARTER };
    if (s === 1) b.high = r.idea.candidate.target! + 1;
    else b.low = r.idea.candidate.target! - 1;
    d.intraday.push(b);
    const result = advance(r.idea, d, defaults, b.end);
    expect(result.idea.state).toBe('final_target');
    expect(result.events.at(-1)!.reasons.join(' ')).toContain('no fill');
  });
  it('issues a ten-day time exit', () => {
    const d = fixture(direction),
      r = advance(idea(d), d, defaults, d.provenance.asOf);
    d.intraday.push({
      ...d.intraday[0]!,
      start: d.provenance.asOf + 10 * DAY,
      end: d.provenance.asOf + 10 * DAY + QUARTER,
    });
    expect(advance(r.idea, d, defaults, d.intraday.at(-1)!.end).idea.state).toBe('time_exit');
  });
  it('rejects opposing relative strength', () => {
    const d = fixture(direction);
    for (let j = 0; j < d.benchmark.length; j++) {
      const b = d.benchmark[j]!;
      b.close = direction === 'bullish' ? 1 + j * j : 10000 * Math.exp(-j * 0.02);
      b.open = b.close;
      b.high = b.close + 1;
      b.low = b.close * 0.9;
    }
    expect(detect(d, defaults, d.provenance.asOf)).toHaveLength(0);
  });
  it('preserves deterministic IDs and ranking', () => {
    const d = fixture(direction),
      a = candidate(d);
    expect(candidate(d).id).toBe(a.id);
    expect(
      rank([
        { ...a, provisionalRR: 4 },
        { ...a, provisionalRR: 6 },
      ])[0]!.provisionalRR,
    ).toBe(6);
  });
});
it('does not identify an unconfirmed future pivot', () => {
  const d = fixture(),
    bars = d.daily.slice(0, -2);
  bars.at(-2)!.high = 120;
  expect(targetFor(bars, 112.5, 110, 10, 'bullish', 252)).toBe(120);
  bars.at(-2)!.high = 115;
  expect(targetFor(bars, 112.5, 110, 10, 'bullish', 252)).toBe(120);
});
it('rejects nearby resistance that leaves less than 3R', () => {
  const d = fixture();
  d.daily.at(-80)!.high = 113;
  expect(detect(d, defaults, d.provenance.asOf)).toHaveLength(0);
});
it('versions validated parameter changes', () => {
  expect(strategyVersion(defaults)).not.toBe(strategyVersion({ ...defaults, minimumRR: 4 }));
  expect(strategySchema.safeParse({ ...defaults, minimumRR: -1 }).success).toBe(false);
});
it('calculates Wilder ATR', () => {
  const bars = Array.from({ length: 5 }, (_, i) => ({
    start: i,
    end: i + 1,
    open: 10,
    close: 10,
    high: 11 + (i === 4 ? 2 : 0),
    low: 9,
    volume: 1,
  }));
  expect(atr(bars, 3)).toBeCloseTo(8 / 3);
});
it('has thirty reproducible synthetic examples, not historical performance claims', () => {
  for (let n = 0; n < 30; n++) {
    const d = fixture(n % 2 ? 'bearish' : 'bullish', n);
    expect(advance(idea(d), d, defaults, d.provenance.asOf).idea.state).toBe('entry_triggered');
  }
});
it('does not emit a ready retest after an earlier close invalidated its breakout', () => {
  const d = fixture(),
    i = idea(d);
  i.lastBar = i.candidate.breakout.end;
  const end = i.candidate.retest!.start + QUARTER;
  d.intraday.unshift({
    start: end - QUARTER,
    end,
    open: 111,
    high: 112,
    low: 108,
    close: 109,
    volume: 10,
  });
  const r = advance(i, d, defaults, d.provenance.asOf);
  expect(r.events.map((e) => e.state)).toEqual(['invalidated']);
});
describe.each(['bullish', 'bearish'] as const)(
  '%s additional qualification boundaries',
  (direction) => {
    it('rejects a daily candle that does not clear the breakout buffer', () => {
      const d = fixture(direction),
        s = direction === 'bullish' ? 1 : -1,
        b = d.daily.at(-2)!;
      b.close = direction === 'bullish' ? 110 : 90;
      b.open = b.close - s * 0.1;
      expect(detect(d, defaults, d.provenance.asOf)).toHaveLength(0);
    });
    it('requires the qualifying retest body direction', () => {
      const d = fixture(direction);
      d.daily.at(-1)!.open = d.daily.at(-1)!.close;
      expect(candidate(d).retest).toBeUndefined();
    });
    it('expires a breakout that never retests in time', () => {
      const d = fixture(direction),
        c = candidate(d);
      delete c.retest;
      const old = {
        candidate: c,
        state: 'watching' as const,
        lastBar: c.breakout.end,
        milestones: [],
        createdAt: c.breakout.end,
      };
      d.intraday = [];
      expect(advance(old, d, defaults, c.breakout.end + 10 * DAY).idea.state).toBe('expired');
    });
    it('treats equality at the level as neither entry nor invalidation', () => {
      const d = fixture(direction),
        old = idea(d),
        b = d.intraday[0]!;
      b.close = old.candidate.level;
      b.open = b.close;
      b.low = Math.min(b.low, b.close);
      b.high = Math.max(b.high, b.close);
      const r = advance(old, d, defaults, d.provenance.asOf);
      expect(r.idea.candidate.entry).toBeUndefined();
      expect(r.events.some((e) => e.state === 'invalidated')).toBe(false);
    });
  },
);
