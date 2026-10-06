import { expect, it } from 'vitest';
import {
  crypto,
  equity,
  type Bar,
  type Dataset,
  type Direction,
  type Interval,
  type Session,
} from '../src/domain.js';
import { DAY, QUARTER } from '../src/core/time.js';
import {
  advanceReversal,
  reversalWarning,
  trackerHistory,
  volumeSpike,
  type PendingReversal,
} from '../src/core/trackers.js';
import { trackWatchlist } from '../src/watch-trackers.js';
import { Store } from '../src/storage.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const start = Date.parse('2026-09-01T00:00:00Z');
function bar(t: number, close = 100, volume = 100, duration = DAY): Bar {
  return {
    start: t,
    end: t + duration,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume,
  };
}
function dataset(daily: Bar[], intraday: Bar[] = [], sessions: Session[] = []): Dataset {
  return {
    instrument: crypto('BTC-USD'),
    daily,
    intraday,
    sessions,
    weekly: [],
    benchmark: daily,
    provenance: {
      provider: 'Coinbase',
      feed: 'spot',
      delayMinutes: 0,
      asOf: daily.at(-1)?.end ?? start,
    },
  };
}
it('uses exactly the prior 10 daily volumes, excluding the trigger and incomplete future candles', () => {
  const daily = Array.from({ length: 12 }, (_, n) => bar(start + n * DAY, 100, n ? 100 : 10000));
  daily[11]!.volume = 200;
  const d = dataset([...daily, bar(start + 12 * DAY, 100, 99999)]);
  const result = volumeSpike(d, '1d', daily[11]!, 2, 10)!;
  expect(result.details).toMatchObject({
    type: 'volume',
    baseline: 100,
    relativeVolume: 2,
    baselineDays: 10,
    priceChange: 0,
  });
  expect(volumeSpike(d, '1d', { ...daily[11]!, volume: 199.99 }, 2, 10)).toBeUndefined();
  expect(volumeSpike(d, '1d', daily[11]!, 3, 10)).toBeUndefined();
});
it('rejects missing daily samples, insufficient history and zero baselines', () => {
  const daily = Array.from({ length: 11 }, (_, n) =>
    bar(start + n * DAY, 100, n === 10 ? 200 : 100),
  );
  expect(volumeSpike(dataset(daily.slice(1)), '1d', daily[10]!, 2, 10)).toBeUndefined();
  expect(
    volumeSpike(dataset(daily.filter((_, n) => n !== 5)), '1d', daily[10]!, 2, 10),
  ).toBeUndefined();
  expect(
    volumeSpike(dataset(daily.map((b) => ({ ...b, volume: 0 }))), '1d', daily[10]!, 2, 10),
  ).toBeUndefined();
});
it('matches crypto UTC slots across midnight rather than the most recent 10 intraday bars', () => {
  const target = bar(start + 11 * DAY + 23 * 3600000 + 3 * QUARTER, 102, 200, QUARTER);
  const history = Array.from({ length: 10 }, (_, n) =>
    bar(target.start - (n + 1) * DAY, 100, 100, QUARTER),
  );
  history.push(
    ...Array.from({ length: 10 }, (_, n) =>
      bar(target.start - (n + 1) * QUARTER, 101, 99999, QUARTER),
    ),
  );
  expect(volumeSpike(dataset([], history), '15m', target, 2, 10)?.details).toMatchObject({
    baseline: 100,
    relativeVolume: 2,
  });
  expect(volumeSpike(dataset([], history.slice(1)), '15m', target, 2, 10)).toBeUndefined();
});
it('uses equity offsets from session open across DST, holidays and early closes', () => {
  const sessions = Array.from({ length: 12 }, (_, n) => {
    const open = start + n * DAY + (n < 5 ? 13.5 : 14.5) * 3600000;
    return {
      date: new Date(open).toISOString().slice(0, 10),
      open,
      close: open + (n === 5 ? 3.5 : 6.5) * 3600000,
    };
  }).filter((_, n) => n !== 3); // holiday has no session
  const targetSession = sessions.at(-1)!,
    offset = 5 * 3600000;
  const target = bar(targetSession.open + offset, 100, 200, QUARTER);
  const history = sessions
    .slice(0, -1)
    .flatMap((s) =>
      s.open + offset + QUARTER <= s.close ? [bar(s.open + offset, 100, 100, QUARTER)] : [],
    );
  const d = dataset([], history, sessions);
  d.instrument = equity('TEST');
  expect(volumeSpike(d, '15m', target, 2, 10)).toBeUndefined(); // nine eligible samples: early-close slot absent
  const older = {
    date: '2026-08-31',
    open: start - DAY + 13.5 * 3600000,
    close: start - DAY + 20 * 3600000,
  };
  d.sessions.unshift(older);
  d.intraday.unshift(bar(older.open + offset, 100, 100, QUARTER));
  expect(volumeSpike(d, '15m', target, 2, 10)?.details).toMatchObject({
    baseline: 100,
    relativeVolume: 2,
  });
  const invalid = bar(targetSession.close, 100, 200, QUARTER);
  expect(volumeSpike(d, '15m', invalid, 2, 10)).toBeUndefined();
});
function reversalFixture(direction: Direction, duration = DAY) {
  const prior = Array.from({ length: 30 }, (_, n) =>
    bar(start + n * duration, 150 - n, 100, duration),
  );
  prior[20]!.high = 160;
  prior[25]!.low = 100;
  const warning = { ...bar(start + 30 * duration, 110, 100, duration), low: 99, high: 112 };
  const mirror = (b: Bar): Bar => ({
    ...b,
    open: 300 - b.open,
    high: 300 - b.low,
    low: 300 - b.high,
    close: 300 - b.close,
  });
  return direction === 'bullish'
    ? { prior, warning }
    : { prior: prior.map(mirror), warning: mirror(warning) };
}
it.each(['bullish', 'bearish'] as const)(
  'detects %s warning from prior trend and fully confirmed pivots only',
  (direction) => {
    const { prior, warning } = reversalFixture(direction);
    const pending = reversalWarning('instrument', '1d', prior, warning)!;
    expect(pending.direction).toBe(direction);
    expect(pending.high).toBe(direction === 'bullish' ? 160 : 200);
    expect(pending.low).toBe(direction === 'bullish' ? 100 : 140);
    const future = { ...warning, high: 999, low: 1 };
    expect(reversalWarning('instrument', '1d', [...prior, future], warning)).toEqual(pending);
    const flat = prior.map((b) => ({
      ...b,
      close: 150,
      open: 150,
      high: Math.max(151, b.high),
      low: Math.min(149, b.low),
    }));
    expect(reversalWarning('instrument', '1d', flat, warning)).toBeUndefined();
  },
);
it('does not use a pivot without its two right-side completed candles', () => {
  const { prior, warning } = reversalFixture('bullish');
  prior[25]!.low = 124;
  prior[29]!.low = 90;
  expect(reversalWarning('i', '1d', prior, { ...warning, low: 89, close: 95 })).toBeUndefined();
});
it.each(['bullish', 'bearish'] as const)(
  'tracks %s confirmation, cancellation, expiry and frozen levels',
  (direction) => {
    const { prior, warning } = reversalFixture(direction);
    const pending = reversalWarning('i', '1d', prior, warning)!;
    const confirm = bar(warning.end, direction === 'bullish' ? pending.high + 1 : pending.low - 1);
    expect(advanceReversal(pending, '1d', confirm).observation?.details).toMatchObject({
      phase: 'confirmed',
      frozenHigh: pending.high,
      frozenLow: pending.low,
      elapsed: 1,
      warningId: pending.id,
    });
    const cancel = bar(warning.end, direction === 'bullish' ? warning.low - 1 : warning.high + 1);
    expect(advanceReversal(pending, '1d', cancel).observation?.details).toMatchObject({
      phase: 'cancelled',
    });
    let current: PendingReversal | undefined = pending;
    for (let n = 1; n <= 5; n++) {
      const result = advanceReversal(
        current!,
        '1d',
        bar(warning.end + (n - 1) * DAY, warning.close),
      );
      current = result.pending;
      if (n === 5)
        expect(result.observation?.details).toMatchObject({ phase: 'expired', elapsed: 5 });
      else expect(result.observation).toBeUndefined();
    }
    expect(
      advanceReversal({ ...pending, elapsed: 4 }, '1d', confirm).observation?.details,
    ).toMatchObject({ phase: 'confirmed', elapsed: 5 });
    // Deliberately contradictory frozen geometry verifies cancellation precedence.
    expect(
      advanceReversal({ ...pending, high: 90, low: 220 }, '1d', cancel).observation?.details,
    ).toMatchObject({ phase: 'cancelled' });
    expect(advanceReversal(pending, '1d', warning).observation).toBeUndefined();
  },
);
it('filters incomplete candles and rejects missing intraday history', () => {
  const bars = [bar(start, 100, 100, QUARTER), bar(start + 2 * QUARTER, 100, 100, QUARTER)];
  expect(() => trackerHistory(dataset([], bars), '15m', start + 3 * QUARTER)).toThrow(
    'MISSING_TRACKER_BARS',
  );
  const contiguous = [bars[0]!, bar(start + QUARTER, 100, 100, QUARTER)];
  expect(trackerHistory(dataset([], contiguous), '15m', start + QUARTER)).toHaveLength(1);
});
it('warms up silently, publishes once, resumes from persisted cursors and never creates ideas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-')),
    path = join(dir, 'db.sqlite');
  let store = new Store(path);
  try {
    const daily = Array.from({ length: 11 }, (_, n) => bar(start + n * DAY));
    const d = dataset(daily);
    trackWatchlist(store, d, daily.at(-1)!.end, true);
    expect(store.pendingCount()).toBe(0);
    const spike = bar(start + 11 * DAY, 102, 200);
    d.daily.push(spike);
    trackWatchlist(store, d, spike.end, false);
    expect(store.pendingCount()).toBe(1);
    expect(store.activeIdeas()).toHaveLength(0);
    const event = store.pending(spike.end)[0]!.event;
    expect(event.kind).toBe('watch_tracker');
    expect(event.tracker).toMatchObject({ baselineDays: 10 });
    store.close();
    store = new Store(path);
    trackWatchlist(store, d, spike.end, false);
    expect(store.pendingCount()).toBe(1);
    store.set('settings', { ...store.settings(), volumeSpikes: false });
    const disabled = bar(start + 12 * DAY, 102, 400);
    d.daily.push(disabled);
    trackWatchlist(store, d, disabled.end, false);
    store.set('settings', { ...store.settings(), volumeSpikes: true });
    trackWatchlist(store, d, disabled.end, false);
    expect(store.pendingCount()).toBe(1);
    const recovered = bar(start + 13 * DAY, 102, 1000);
    d.daily.push(recovered);
    trackWatchlist(store, d, recovered.end, true);
    expect(store.pendingCount()).toBe(1);
    const fresh = bar(start + 14 * DAY, 102, 1000);
    d.daily.push(fresh);
    trackWatchlist(store, d, fresh.end, false);
    expect(store.pendingCount()).toBe(2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it.each(['1d', '15m'] as const)(
  'silently rebuilds %s pending reversals, but follows up only announced warnings',
  (timeframe) => {
    const store = new Store(':memory:');
    try {
      const duration = timeframe === '1d' ? DAY : QUARTER;
      const { prior, warning } = reversalFixture('bullish', duration);
      const d = timeframe === '1d' ? dataset([...prior]) : dataset([], [...prior]);
      trackWatchlist(store, d, prior.at(-1)!.end, true);
      const history = timeframe === '1d' ? d.daily : d.intraday;
      history.push(warning);
      trackWatchlist(store, d, warning.end, false);
      expect(
        store.pending(warning.end).filter((p) => p.event.tracker?.type === 'reversal'),
      ).toHaveLength(1);
      const confirm = bar(warning.end, 161, 100, duration);
      history.push(confirm);
      // Follow-ups bypass even a future cooldown timestamp.
      store.cooldown(
        `tracker:v1:${d.instrument.id}:${timeframe}:reversal:bullish`,
        confirm.end + DAY,
      );
      trackWatchlist(store, d, confirm.end, false);
      trackWatchlist(store, d, confirm.end, false);
      expect(
        store.pending(confirm.end).filter((p) => p.event.tracker?.type === 'reversal'),
      ).toHaveLength(2);
      expect(store.activeIdeas()).toHaveLength(0);
      const silent = new Store(':memory:');
      try {
        const warm =
          timeframe === '1d' ? dataset([...prior, warning]) : dataset([], [...prior, warning]);
        trackWatchlist(silent, warm, warning.end, true);
        (timeframe === '1d' ? warm.daily : warm.intraday).push(confirm);
        trackWatchlist(silent, warm, confirm.end, false);
        expect(silent.pendingCount()).toBe(0);
      } finally {
        silent.close();
      }
    } finally {
      store.close();
    }
  },
);
it('merges tracker defaults into older settings without changing the master switch', () => {
  const store = new Store(':memory:');
  try {
    store.set('settings', { alerts: false, options: false, paused: false, channels: {} });
    expect(store.settings()).toMatchObject({
      alerts: false,
      volumeSpikes: true,
      reversals: true,
      volumeMultiplier: 2,
    });
  } finally {
    store.close();
  }
});

it.each(['buying', 'selling', 'neutral'] as const)(
  'labels %s pressure as a candle-direction estimate',
  (pressure) => {
    const daily = Array.from({ length: 11 }, (_, n) => bar(start + n * DAY));
    const target = {
      ...daily[10]!,
      volume: 200,
      open: pressure === 'buying' ? 99.5 : pressure === 'selling' ? 100.5 : 100,
    };
    expect(volumeSpike(dataset(daily), '1d', target, 2, 10)?.details).toMatchObject({
      pressure,
      pressureBasis: 'candle_direction',
    });
  },
);
it('keeps timeframe cooldowns independent and suppresses repeated intraday spikes for four hours', () => {
  const store = new Store(':memory:');
  try {
    const daily = Array.from({ length: 11 }, (_, n) => bar(start + n * DAY));
    const intraday = Array.from({ length: 12 * 96 - 1 }, (_, n) =>
      bar(start + n * QUARTER, 100, 100, QUARTER),
    );
    const d = dataset(daily, intraday);
    const initial = intraday.at(-1)!.end;
    trackWatchlist(store, d, initial, true);
    const target = bar(initial, 101, 200, QUARTER);
    d.intraday.push(target);
    d.daily.push(bar(start + 11 * DAY, 101, 200));
    trackWatchlist(store, d, target.end, false);
    expect(
      store.pending(target.end).filter((p) => p.event.tracker?.type === 'volume'),
    ).toHaveLength(2);
    const next = bar(target.end, 101, 200, QUARTER);
    d.intraday.push(next);
    trackWatchlist(store, d, next.end, false);
    expect(store.pendingCount()).toBe(2);
    for (let n = 1; n <= 16; n++)
      d.intraday.push(bar(next.end + (n - 1) * QUARTER, 101, n === 16 ? 200 : 100, QUARTER));
    trackWatchlist(store, d, d.intraday.at(-1)!.end, false);
    expect(store.pendingCount()).toBe(3);
  } finally {
    store.close();
  }
});
it('does not reannounce warnings made with reversals or the master switch disabled', () => {
  for (const setting of ['reversals', 'alerts'] as const) {
    const store = new Store(':memory:');
    try {
      const { prior, warning } = reversalFixture('bullish');
      const d = dataset([...prior]);
      trackWatchlist(store, d, prior.at(-1)!.end, true);
      store.set('settings', { ...store.settings(), [setting]: false });
      d.daily.push(warning);
      trackWatchlist(store, d, warning.end, false);
      store.set('settings', { ...store.settings(), [setting]: true });
      trackWatchlist(store, d, warning.end, false);
      d.daily.push(bar(warning.end, 161));
      trackWatchlist(store, d, warning.end + DAY, false);
      expect(store.pendingCount()).toBe(0);
    } finally {
      store.close();
    }
  }
});
it('rolls back cursors, warnings, cooldowns and the journal together if enqueue fails', () => {
  const store = new Store(':memory:');
  try {
    const daily = Array.from({ length: 11 }, (_, n) => bar(start + n * DAY));
    const d = dataset(daily);
    trackWatchlist(store, d, daily.at(-1)!.end, true);
    const before = store.get(`tracker:v1:${d.instrument.id}:1d`, null);
    const target = bar(start + 11 * DAY, 100, 200);
    d.daily.push(target);
    const enqueue = store.enqueue.bind(store);
    store.enqueue = (event, route) => {
      enqueue(event, route);
      throw new Error('Simulated write failure');
    };
    expect(() => trackWatchlist(store, d, target.end, false)).toThrow('Simulated write failure');
    expect(store.get(`tracker:v1:${d.instrument.id}:1d`, null)).toEqual(before);
    expect(store.pendingCount()).toBe(0);
    expect(store.journal()).toHaveLength(0);
    store.enqueue = enqueue;
    trackWatchlist(store, d, target.end, false);
    expect(store.pendingCount()).toBe(1);
  } finally {
    store.close();
  }
});

it('rebuilds silently when an outage extends beyond available replay history', () => {
  const store = new Store(':memory:');
  try {
    const { prior, warning } = reversalFixture('bullish');
    const d = dataset([...prior]);
    trackWatchlist(store, d, prior.at(-1)!.end, true);
    d.daily.push(warning);
    trackWatchlist(store, d, warning.end, false);
    expect(store.pendingCount()).toBe(1);
    const later = Array.from({ length: 70 }, (_, n) =>
      bar(start + (100 + n) * DAY, 170, n === 69 ? 200 : 100),
    );
    d.daily = later;
    trackWatchlist(store, d, later.at(-1)!.end, false);
    expect(store.pendingCount()).toBe(1);
    expect(
      store.get<{ pending?: unknown }>(`tracker:v1:${d.instrument.id}:1d`, {}).pending,
    ).toBeUndefined();
  } finally {
    store.close();
  }
});
