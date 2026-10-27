import { expect, it } from 'vitest';
import {
  marketMilliseconds,
  HOUR,
  quoteProblem,
  returnMeasurement,
  returnQualifies,
  parseContract,
  thresholdSchema,
  contractionRatio,
} from '../src/threshold/core.js';
import { nyTime } from '../src/adapters/alpaca.js';
import { thresholdFixture, open, mature, contract } from './threshold-fixtures.js';
import type { ThresholdMonitor } from '../src/threshold/types.js';

it('counts only session overlaps, including early closes, weekends and daylight saving changes', () => {
  const sessions = [
    {
      date: '2026-10-30',
      open: nyTime('2026-10-30', '09:30'),
      close: nyTime('2026-10-30', '16:00'),
    },
    {
      date: '2026-11-02',
      open: nyTime('2026-11-02', '09:30'),
      close: nyTime('2026-11-02', '13:00'),
    },
  ];
  expect(
    marketMilliseconds(
      nyTime('2026-10-30', '15:00'),
      nyTime('2026-11-02', '13:30'),
      'equity',
      sessions,
    ) / HOUR,
  ).toBe(4.5);
  expect(marketMilliseconds(20, 10, 'crypto', [])).toBe(0);
  expect(marketMilliseconds(10, 20, 'crypto', [])).toBe(10);
  expect(nyTime('2026-11-02', '09:30') % (24 * HOUR)).not.toBe(
    nyTime('2026-10-30', '09:30') % (24 * HOUR),
  );
});
it.each(['AAPL261218C00100000', 'AAPL261218P00100000'])(
  'parses standard OCC calls/puts: %s',
  (value) => {
    expect(parseContract(value)).toMatchObject({
      symbol: 'AAPL',
      expiry: '2026-12-18',
      contract: value,
    });
  },
);
it.each([
  'AAPL1261218C00100000',
  'SPY261332C00100000',
  'AAPL261231C00000000',
  'AAPL261218C00100000/AAPL261218C00110000',
  'AAPL260230P00100000',
])('rejects invalid/adjusted contract %s', (value) => expect(() => parseContract(value)).toThrow());
it.each([
  { hours: 0 },
  { hours: 25 },
  { progressAtr: 0.01 },
  { contractLossPercent: 21 },
  { ideaLossR: 0.51 },
])('validates rule bounds %j', (patch) => expect(() => thresholdSchema.parse(patch)).toThrow());
it('calculates exact net contract estimates, fees, quantities and unlimited profit', () => {
  const f = thresholdFixture();
  try {
    const m = f.add('alice', { quantity: 3, fees: 1 });
    expect(returnMeasurement(m, 100, { ...f.quote(open), bid: 2.01 })!.returnPercent).toBeCloseTo(
      0,
    );
    expect(returnMeasurement(m, 100, { ...f.quote(open), bid: 3 })!.estimatedNet).toBe(297);
    expect(
      returnQualifies(m, returnMeasurement(m, 100, { ...f.quote(open), bid: 3 }), {
        ...f.quote(open),
        bid: 3,
      }),
    ).toBe(true);
    expect(f.store.journal().filter((e) => e.kind === 'threshold_alert')).toHaveLength(0);
  } finally {
    f.store.close();
  }
});
it('includes exactly -5%, requires a stop for losses, and rejects exact stop touches', () => {
  const f = thresholdFixture();
  try {
    const m = f.add(),
      q = { ...f.quote(open), bid: 1.9 };
    expect(returnQualifies(m, returnMeasurement(m, 100, q), q)).toBe(true);
    expect(
      returnQualifies(m, returnMeasurement(m, 100, { ...q, bid: 1.899 }), { ...q, bid: 1.899 }),
    ).toBe(false);
    delete m.stop;
    expect(returnQualifies(m, returnMeasurement(m, 100, q), q)).toBe(false);
    m.stop = 1.9;
    expect(returnQualifies(m, returnMeasurement(m, 100, q), q)).toBe(false);
    q.bid = 2;
    expect(returnQualifies(m, returnMeasurement(m, 100, q), q)).toBe(true);
  } finally {
    f.store.close();
  }
});
it.each(['bullish', 'bearish'] as const)(
  'uses -0.05R rather than -5%% price movement for %s ideas',
  (direction) => {
    const m = {
      mode: 'idea',
      direction,
      entry: 100,
      risk: 2,
      rules: { ideaLossR: 0.05 },
    } as ThresholdMonitor;
    const close = direction === 'bullish' ? 99.9 : 100.1;
    expect(returnQualifies(m, returnMeasurement(m, close))).toBe(true);
    expect(returnQualifies(m, returnMeasurement(m, direction === 'bullish' ? 99.89 : 100.11))).toBe(
      false,
    );
    expect(returnQualifies(m, returnMeasurement(m, direction === 'bullish' ? 150 : 50))).toBe(true);
  },
);
it.each([
  { bid: 0 },
  { ask: 1 },
  { bidSize: 0 },
  { askSize: 0 },
  { asOf: open + 1 },
  { asOf: open - 300001 },
  { ask: 3 },
  { bid: NaN },
  { contract: 'different' },
])('rejects unusable quote %j', (patch) => {
  const f = thresholdFixture();
  try {
    expect(quoteProblem({ ...f.quote(open), ...patch }, contract, 1, open)).toBeDefined();
  } finally {
    f.store.close();
  }
});
it('accepts exact five-minute age and 20% spread boundaries but requires bid size for the position', () => {
  const f = thresholdFixture();
  try {
    const q = { ...f.quote(open), bid: 1.8, ask: 2.2, asOf: open - 300000, bidSize: 2 };
    expect(quoteProblem(q, contract, 2, open)).toBeUndefined();
    expect(quoteProblem(q, contract, 3, open)).toBeDefined();
  } finally {
    f.store.close();
  }
});
it('measures optional range contraction from prior matching slots without future leakage', () => {
  const f = thresholdFixture();
  try {
    const d = f.dataset(mature),
      recent = d.intraday.slice(-4);
    for (const b of recent) {
      b.high = 100.5;
      b.low = 99.5;
    }
    expect(contractionRatio(d, mature)).toBeCloseTo(0.5);
    d.intraday.push({ ...recent[0]!, start: mature + 900000, end: mature + 1800000, high: 200 });
    expect(contractionRatio(d, mature)).toBeCloseTo(0.5);
    d.intraday = d.intraday.slice(-8);
    expect(contractionRatio(d, mature)).toBeUndefined();
  } finally {
    f.store.close();
  }
});
