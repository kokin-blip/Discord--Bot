import { expect, it } from 'vitest';
import { chartView } from '../src/chart-view.js';
import { fixture, idea } from './fixtures.js';
import { advance, makeEvent } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';

it.each(['bullish', 'bearish'] as const)(
  'marks the exact completed %s entry candle on a 15m chart without future bars',
  (direction) => {
    const data = fixture(direction),
      result = advance(idea(data), data, defaults, data.provenance.asOf);
    const event = result.events.find((e) => e.state === 'entry_triggered')!;
    data.intraday.push({
      ...data.intraday[0]!,
      start: event.marketTime,
      end: event.marketTime + 900000,
    });
    const view = chartView(data, event.candidate, event);
    expect(view.intraday).toBe(true);
    expect(view.call?.end).toBe(event.marketTime);
    expect(view.bars.every((b) => b.end <= event.marketTime)).toBe(true);
    expect(view.label).toBe(direction === 'bullish' ? 'BUY' : 'Bearish entry');
    const exit = { ...event, state: 'invalidated' as const };
    expect(chartView(data, exit.candidate, exit).label).toBe(
      direction === 'bullish' ? 'SELL' : 'EXIT',
    );
  },
);
it('keeps daily breakout and retest calls on their own candles and never substitutes a missing call', () => {
  const data = fixture(),
    original = idea(data);
  const watching = makeEvent(
    original,
    'watching',
    original.candidate.breakout.end,
    data,
    data.provenance.asOf,
    [],
  );
  const ready = advance(original, data, defaults, data.provenance.asOf).events[0]!;
  expect(chartView(data, watching.candidate, watching).call?.start).toBe(
    original.candidate.breakout.start,
  );
  expect(chartView(data, ready.candidate, ready).call?.start).toBe(
    original.candidate.retest!.start,
  );
  expect(chartView(data, ready.candidate, ready).intraday).toBe(false);
  const missing = { ...watching, marketTime: watching.marketTime + 1 };
  expect(chartView(data, missing.candidate, missing).call).toBeUndefined();
  const snapshot = {
    ...watching,
    kind: 'setup_snapshot' as const,
    marketTime: data.provenance.asOf,
  };
  expect(chartView(data, snapshot.candidate, snapshot).label).toBe('Setup snapshot');
});
