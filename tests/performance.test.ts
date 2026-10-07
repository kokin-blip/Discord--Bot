import { expect, it } from 'vitest';
import { fixture, idea } from './fixtures.js';
import { advance } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';
import { QUARTER } from '../src/core/time.js';
import { publicCard } from '../src/discord/cards.js';
import { Store } from '../src/storage.js';

it.each(['bullish', 'bearish'] as const)(
  'journals %s performance and cumulative targets from the exact completed candle',
  (direction) => {
    const data = fixture(direction),
      initial = advance(idea(data), data, defaults, data.provenance.asOf);
    const c = initial.idea.candidate,
      s = direction === 'bullish' ? 1 : -1;
    const close = c.targets![1]!;
    const bar = {
      ...data.intraday[0]!,
      start: data.provenance.asOf,
      end: data.provenance.asOf + QUARTER,
      open: c.entry!,
      close,
      high: Math.max(close, c.entry!) + 0.01,
      low: Math.min(close, c.entry!) - 0.01,
    };
    data.intraday.push(bar);
    expect(advance(initial.idea, data, defaults, bar.end - 1).events).toHaveLength(0);
    const result = advance(initial.idea, data, defaults, bar.end);
    expect(result.events.map((e) => e.state)).toEqual(['target_1', 'target_2']);
    const event = result.events.at(-1)!;
    expect(event.performance?.changePercent).toBeCloseTo(
      ((s * (close - c.entry!)) / c.entry!) * 100,
    );
    expect(event.performance?.rMultiple).toBe(2);
    expect(event.performance?.referencePrice).toBe(close);
    expect(event.performance?.reachedTargets).toEqual([0, 1]);
    const embed = publicCard(event).toJSON();
    expect(embed.title).toContain(direction === 'bullish' ? 'LONG' : 'SHORT');
    const levels = embed.fields!.find((f) => f.name === 'Target progress')!.value;
    expect(levels).toContain('~~1R:');
    expect(levels).toContain('~~2R:');
    expect(levels).not.toContain('~~Final:');
    expect(embed.fields!.find((f) => f.name === 'Signal performance')!.value).toContain(
      'not realized P/L',
    );
    expect(result.idea.candidate.entry).toBe(c.entry);
    expect(result.idea.candidate.targets).toEqual(c.targets);
    const store = new Store(':memory:');
    try {
      store.saveIdea(result.idea, result.events);
      expect(store.journal().at(-1)!.performance).toEqual(event.performance);
      expect(store.pending(Date.now()).every((pending) => pending.route === 'updates')).toBe(true);
    } finally {
      store.close();
    }
  },
);
it.each(['bullish', 'bearish'] as const)(
  'records %s losing exits and ambiguous touches without a winning claim',
  (direction) => {
    const data = fixture(direction),
      initial = advance(idea(data), data, defaults, data.provenance.asOf);
    const c = initial.idea.candidate,
      s = direction === 'bullish' ? 1 : -1;
    const bar = {
      ...data.intraday[0]!,
      start: data.provenance.asOf,
      end: data.provenance.asOf + QUARTER,
      close: c.level - s,
      high: Math.max(c.targets![2]!, c.entry!) + 1,
      low: Math.min(c.targets![2]!, c.entry!) - 1,
    };
    data.intraday.push(bar);
    const event = advance(initial.idea, data, defaults, bar.end).events[0]!;
    expect(event.state).toBe('invalidated');
    expect(event.performance!.changePercent).toBeLessThan(0);
    expect(event.performance!.ambiguous).toBe(true);
    expect(event.performance!.reachedTargets).toEqual([]);
    const embed = publicCard(event).toJSON();
    expect(embed.description).toContain('ordering unknown');
    expect(embed.fields!.find((f) => f.name === 'Target progress')!.value).not.toContain('~~');
  },
);
it('omits unknown performance in older exit events instead of inventing a price', () => {
  const data = fixture(),
    initial = advance(idea(data), data, defaults, data.provenance.asOf);
  const event = { ...initial.events.at(-1)!, state: 'time_exit' as const, performance: undefined };
  expect(
    publicCard(event)
      .toJSON()
      .fields!.some((f) => f.name === 'Signal performance'),
  ).toBe(false);
});
