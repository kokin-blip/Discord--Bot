import { expect, it } from 'vitest';
import { chartView } from '../src/chart-view.js';
import { fixture, idea } from './fixtures.js';
import { advance, makeEvent } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';
import { debugSample } from '../src/discord/debug.js';

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
    expect(view.label).toBe(direction === 'bullish' ? 'BUY' : 'SHORT');
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

it('defaults symbol and candidate charts to completed 15m bars, with daily context', () => {
  const data = fixture();
  const original = idea(data);
  const completed = data.intraday[0]!;
  data.intraday.push({ ...completed, start: completed.end, end: completed.end + 900000 });
  for (const candidate of [undefined, original.candidate]) {
    const view = chartView(data, candidate);
    expect(view.intraday).toBe(true);
    expect(view.bars).toEqual([completed]);
    expect(view.context).toEqual(data.daily.slice(-100));
  }
});

it('uses a 15m primary view while keeping daily setup markers in daily context', () => {
  const data = fixture();
  const original = idea(data);
  const watching = makeEvent(
    original,
    'watching',
    original.candidate.breakout.end,
    data,
    data.provenance.asOf,
    [],
  );
  const ready = advance(original, data, defaults, data.provenance.asOf).events[0]!;
  // Include exact closing 15m candles: matching timestamps must not relabel daily signals.
  data.intraday = [watching, ready].map((event) => ({
    ...data.intraday[0]!,
    start: event.marketTime - 900000,
    end: event.marketTime,
  }));
  const snapshot = {
    ...watching,
    kind: 'setup_snapshot' as const,
    marketTime: data.provenance.asOf,
  };
  for (const event of [watching, ready, snapshot]) {
    const view = chartView(data, event.candidate, event);
    expect(view.intraday).toBe(true);
    expect(view.call).toBeUndefined();
    expect(view.contextCall).toEqual(
      event.kind === 'setup_snapshot'
        ? (event.candidate.retest ?? event.candidate.breakout)
        : data.daily.find((bar) => bar.end === event.marketTime),
    );
    expect([...view.bars, ...view.context].every((bar) => bar.end <= event.marketTime)).toBe(true);
  }
  const missing = { ...watching, marketTime: watching.marketTime + 1 };
  expect(chartView(data, missing.candidate, missing).contextCall).toBeUndefined();
});

it('falls back to daily history when no completed 15m bars are available', () => {
  const data = fixture();
  data.provenance.asOf = data.intraday[0]!.start;
  const view = chartView(data);
  expect(view.intraday).toBe(false);
  expect(view.bars).toEqual(data.daily.slice(-100));
  expect(view.context).toEqual(data.weekly.slice(-60));
});

it('preserves an explicitly daily tracker chart even when 15m history exists', () => {
  const { data, event } = debugSample(Date.parse('2026-10-20T12:00:00Z'), 'daily-chart');
  event.tracker!.timeframe = '1d';
  event.marketTime = data.daily.at(-1)!.end;
  expect(event.tracker?.timeframe).toBe('1d');
  data.intraday = [{ ...data.daily.at(-1)!, start: event.marketTime - 900000 }];
  const view = chartView(data, event.candidate, event);
  expect(view.intraday).toBe(false);
  expect(view.call?.end).toBe(event.marketTime);
  expect(view.contextCall).toBeUndefined();
});
