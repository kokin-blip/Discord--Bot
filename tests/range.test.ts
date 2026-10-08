import { expect, it } from 'vitest';
import { rangeExpansion } from '../src/core/trackers.js';
import { DAY, QUARTER } from '../src/core/time.js';
import { crypto, equity, type Bar, type Dataset } from '../src/domain.js';
import { Store } from '../src/storage.js';
import { trackWatchlist } from '../src/watch-trackers.js';
import { debugSample } from '../src/discord/debug.js';
import { trackerCard } from '../src/discord/cards.js';
import { chartView } from '../src/chart-view.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Learning } from '../src/learning.js';
const start = Date.parse('2026-09-01T00:00:00Z');
const bar = (t: number, duration = DAY): Bar => ({
  start: t,
  end: t + duration,
  open: 100,
  close: 100,
  high: 101,
  low: 99,
  volume: 100,
});
function data(): Dataset {
  const daily = Array.from({ length: 11 }, (_, n) => bar(start + n * DAY));
  return {
    instrument: crypto('BTC-USD'),
    daily,
    intraday: [],
    weekly: [],
    benchmark: daily,
    sessions: [],
    provenance: { provider: 'test', feed: 'spot', delayMinutes: 0, asOf: daily.at(-1)!.end },
  };
}
it.each(['upward', 'downward', 'neutral'] as const)(
  'detects exact equality and %s candle bodies without future data',
  (direction) => {
    const d = data(),
      b = d.daily.at(-1)!;
    Object.assign(b, {
      high: 103,
      low: 97,
      close: direction === 'upward' ? 102 : direction === 'downward' ? 98 : 100,
    });
    const r = rangeExpansion(d, '1d', b, 3)!;
    expect(r.details).toMatchObject({
      type: 'range',
      range: 6,
      baseline: 2,
      relativeRange: 3,
      candleDirection: direction,
    });
    if (r.details.type === 'range')
      expect(r.details.bodyPercent).toBeCloseTo(direction === 'neutral' ? 0 : 100 / 3);
    d.daily.push({ ...bar(b.end), high: 999 });
    expect(rangeExpansion(d, '1d', b, 3)?.id).toBe(r.id);
    expect(rangeExpansion(d, '1d', { ...b, high: 102.999 }, 3)).toBeUndefined();
    expect(rangeExpansion(d, '1d', d.daily.at(-1)!, 3)).toBeUndefined();
  },
);
it('rejects missing/invalid samples and zero baselines, while zero volume remains unknown', () => {
  const d = data(),
    b = d.daily.at(-1)!;
  Object.assign(b, { high: 103, low: 97 });
  d.daily = d.daily.map((x) => ({ ...x, volume: 0 }));
  expect(rangeExpansion(d, '1d', b, 3)?.details).toMatchObject({
    type: 'range',
    bodyPercent: 0,
    closeLocationPercent: 50,
  });
  expect(rangeExpansion(d, '1d', b, 3)?.details).not.toHaveProperty('relativeVolume');
  expect(
    rangeExpansion({ ...d, daily: d.daily.filter((_, n) => n !== 5) }, '1d', b, 3),
  ).toBeUndefined();
  expect(
    rangeExpansion(
      { ...d, daily: d.daily.map((x) => ({ ...x, low: x.close, high: x.close })) },
      '1d',
      b,
      3,
    ),
  ).toBeUndefined();
  expect(
    rangeExpansion(
      { ...d, daily: d.daily.map((x, n) => (n === 5 ? { ...x, high: 98 } : x)) },
      '1d',
      b,
      3,
    ),
  ).toBeUndefined();
});
it('matches UTC slots, excluding recent bars and rejecting incomplete durations', () => {
  const d = data(),
    b = { ...bar(start + 12 * DAY, QUARTER), high: 103, low: 97 };
  d.provenance.asOf = b.end;
  d.intraday = Array.from({ length: 10 }, (_, n) => bar(b.start - (n + 1) * DAY, QUARTER));
  d.intraday.push({ ...bar(b.start - QUARTER, QUARTER), high: 500 });
  expect(rangeExpansion(d, '15m', b, 3)?.details).toMatchObject({ baseline: 2, relativeRange: 3 });
  expect(rangeExpansion(d, '15m', { ...b, end: b.end - 1 }, 3)).toBeUndefined();
});
it('uses session offsets across DST, holidays and early closes', () => {
  const d = data();
  d.instrument = equity('AAPL');
  const dates = [
    '2026-10-19',
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-26',
    '2026-10-27',
    '2026-10-28',
    '2026-10-29',
    '2026-10-30',
    '2026-11-02',
    '2026-11-03',
  ];
  d.sessions = dates.map((date, n) => ({
    date,
    open: Date.parse(`${date}T${n < 10 ? '13' : '14'}:30:00Z`),
    close: Date.parse(`${date}T${n === 8 ? '17' : n < 10 ? '20' : '21'}:00:00Z`),
  }));
  const offset = 4 * 3600000;
  const b = { ...bar(d.sessions.at(-1)!.open + offset, QUARTER), high: 103, low: 97 };
  d.provenance.asOf = b.end;
  d.intraday = d.sessions
    .slice(0, -1)
    .filter((s) => s.open + offset + QUARTER <= s.close)
    .map((s) => bar(s.open + offset, QUARTER));
  expect(rangeExpansion(d, '15m', b, 3)?.details).toMatchObject({ baseline: 2 });
  d.intraday.pop();
  expect(rangeExpansion(d, '15m', b, 3)).toBeUndefined();
});
it.each([
  ['both', true, true],
  ['range', false, true],
  ['volume', true, false],
  ['off', false, false],
] as const)('combines or independently emits enabled trackers: %s', (_, volume, range) => {
  const store = new Store(':memory:');
  try {
    const d = data(),
      trigger = d.daily.pop()!;
    d.provenance.asOf = trigger.end;
    store.set('settings', {
      ...store.settings(),
      volumeSpikes: volume,
      rangeExpansion: range,
      reversals: false,
    });
    trackWatchlist(store, d, trigger.start, true);
    Object.assign(trigger, { high: 103, low: 97, volume: 200 });
    d.daily.push(trigger);
    trackWatchlist(store, d, trigger.end, false);
    const events = store.pending(trigger.end).filter((p) => p.event.kind === 'watch_tracker');
    expect(events).toHaveLength(volume || range ? 1 : 0);
    if (events.length)
      expect(events[0]!.event.tracker).toMatchObject(
        range ? { type: 'range', ...(volume ? { combinedVolume: true } : {}) } : { type: 'volume' },
      );
    trackWatchlist(store, d, trigger.end, false);
    expect(store.pendingCount()).toBe(events.length);
    expect(store.activeIdeas()).toHaveLength(0);
    new Learning(store).process(trigger.end);
    expect(store.db.prepare('SELECT * FROM learning_pending').all()).toHaveLength(0);
  } finally {
    store.close();
  }
});
it('combined alerts cover both cooldowns when only one is eligible', () => {
  const store = new Store(':memory:');
  try {
    const d = data(),
      b = d.daily.pop()!;
    d.provenance.asOf = b.end;
    trackWatchlist(store, d, b.start, true);
    store.markCooldown(`tracker:v1:${d.instrument.id}:1d:volume:neutral`, b.end - 1000);
    Object.assign(b, { high: 103, low: 97, volume: 200 });
    d.daily.push(b);
    trackWatchlist(store, d, b.end, false);
    expect(store.pending(b.end).filter((p) => p.event.tracker?.type === 'range')).toHaveLength(1);
    expect(store.cooldown(`tracker:v1:${d.instrument.id}:1d:volume:neutral`, b.end + 1000)).toBe(
      false,
    );
    expect(store.cooldown(`tracker:v1:${d.instrument.id}:1d:range:neutral`, b.end + 1000)).toBe(
      false,
    );
  } finally {
    store.close();
  }
});
it('warmup, recovery and disabled trackers never replay old range alerts', () => {
  for (const mode of ['warmup', 'recovery', 'disabled'] as const) {
    const store = new Store(':memory:');
    try {
      const d = data(),
        b = d.daily.at(-1)!;
      Object.assign(b, { high: 103, low: 97 });
      if (mode !== 'warmup')
        trackWatchlist(store, { ...d, daily: d.daily.slice(0, -1) }, b.start, true);
      if (mode === 'disabled')
        store.set('settings', { ...store.settings(), rangeExpansion: false });
      trackWatchlist(store, d, b.end, mode === 'recovery');
      store.set('settings', { ...store.settings(), rangeExpansion: true });
      trackWatchlist(store, d, b.end, false);
      expect(store.pending(b.end).filter((p) => p.event.tracker?.type === 'range')).toHaveLength(0);
    } finally {
      store.close();
    }
  }
});
it.each(['range', 'combined'] as const)(
  'creates coherent %s synthetic cards, detailed metrics and exact marker',
  (type) => {
    const { data: d, event } = debugSample(Date.now(), type, type);
    expect(event.tracker).toMatchObject({ type: 'range', candleDirection: 'downward' });
    expect(trackerCard(event).toJSON().title).toContain('LARGE DOWNWARD CANDLE');
    expect(
      trackerCard(event, true)
        .toJSON()
        .fields!.some((f) => f.name === 'Body strength'),
    ).toBe(true);
    expect(chartView(d, undefined, event).call).toEqual(event.candidate.breakout);
    expect(chartView(d, undefined, event).label).toContain('range');
  },
);

it('evaluates fresh intraday candles using scheduler cutoff even when provenance reflects yesterday daily close', () => {
  const store = new Store(':memory:');
  try {
    const { data: d, event } = debugSample(Date.now(), 'intraday-cutoff', 'range');
    const trigger = d.intraday.pop()!;
    d.provenance.asOf = d.daily.at(-1)!.end;
    trackWatchlist(store, d, trigger.start, true);
    d.intraday.push(trigger);
    trackWatchlist(store, d, trigger.end, false);
    expect(
      store.pending(trigger.end).filter((p) => p.event.tracker?.type === 'range'),
    ).toHaveLength(1);
    expect(
      store.pending(trigger.end).find((p) => p.event.tracker?.type === 'range')!.event.marketTime,
    ).toBe(event.marketTime);
  } finally {
    store.close();
  }
});

it('rejects truncated daily candles and malformed baseline durations', () => {
  const d = data(),
    b = { ...d.daily.at(-1)!, high: 103, low: 97 };
  expect(rangeExpansion(d, '1d', { ...b, end: b.end - 1 }, 3)).toBeUndefined();
  d.daily[2]!.end -= 1;
  expect(rangeExpansion(d, '1d', b, 3)).toBeUndefined();
});

it('persists range cursor and outbox across process restart without duplicate delivery items', () => {
  const directory = mkdtempSync(join(tmpdir(), 'range-restart-'));
  let store = new Store(join(directory, 'state.sqlite'));
  try {
    const d = data(),
      b = d.daily.pop()!;
    d.provenance.asOf = b.end;
    trackWatchlist(store, d, b.start, true);
    Object.assign(b, { high: 103, low: 97 });
    d.daily.push(b);
    trackWatchlist(store, d, b.end, false);
    const count = store.pendingCount();
    expect(count).toBe(1);
    store.close();
    store = new Store(join(directory, 'state.sqlite'));
    trackWatchlist(store, d, b.end, true);
    trackWatchlist(store, d, b.end, false);
    expect(store.pendingCount()).toBe(count);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
