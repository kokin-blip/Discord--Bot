import { it, expect } from 'vitest';
import { Store } from '../src/storage.js';
import { fixture, idea, candidate } from './fixtures.js';
import { defaults } from '../src/config.js';
import {
  advance,
  detect,
  entryIntervals,
  findRetest,
  strategyVersion,
  stableId,
} from '../src/core/strategy.js';
import { DAY, QUARTER, weeklyBars } from '../src/core/time.js';
import {
  beginEconomics,
  entryAssumptions,
  stepEconomics,
  netR,
  availableAt,
} from '../src/entry-research/execution.js';
import { EntryResearch, type EntryCohort } from '../src/entry-research/engine.js';
import { entryReport, weekBound } from '../src/entry-research/report.js';
import { Scorecard } from '../src/scorecard.js';
import type { Dataset, SignalEvent } from '../src/domain.js';
import { benchmarkFor } from '../src/domain.js';

it.each(['bullish', 'bearish'] as const)(
  'retains a viable %s tight entry rejected by the provisional R/R gate',
  (direction) => {
    const d = fixture(direction),
      old = candidate(d),
      s = direction === 'bullish' ? 1 : -1;
    if (s === 1) d.daily.at(-80)!.high = 113;
    else d.daily.at(-80)!.low = 87;
    const b = d.daily.at(-1)!,
      price = (a: number) => old.level + s * a * old.atr;
    Object.assign(b, {
      open: price(0.05),
      close: price(0.12),
      high: s === 1 ? price(0.15) : old.level,
      low: s === 1 ? old.level : price(0.15),
    });
    expect(detect(d, defaults, d.provenance.asOf)).toHaveLength(0);
    const c = detect(d, defaults, d.provenance.asOf, undefined, 'feasible').find(
      (c) => c.direction === direction,
    )!;
    expect(c).toBeDefined();
    expect(c.retest).toBeDefined();
    expect(entryIntervals(d, c, defaults).length).toBeGreaterThan(0);
    const at = (a: number) => c.level + s * a * c.atr;
    Object.assign(d.intraday[0]!, {
      open: at(0.15),
      close: at(0.2),
      high: s === 1 ? at(0.21) : at(0.14),
      low: s === 1 ? at(0.14) : at(0.21),
    });
    const initial = {
      candidate: c,
      state: 'watching' as const,
      lastBar: c.retest!.end,
      milestones: [],
      createdAt: d.provenance.asOf,
    };
    expect(advance(initial, d, defaults, d.provenance.asOf, true, 'feasible').idea.state).toBe(
      'entry_triggered',
    );
  },
);
it.each(['bullish', 'bearish'] as const)(
  'skips an impossible %s retest and accepts a later feasible retest',
  (direction) => {
    const d = fixture(direction),
      c = candidate(d),
      s = direction === 'bullish' ? 1 : -1,
      r = d.daily.at(-1)!,
      at = (a: number) => c.level + s * a * c.atr;
    Object.assign(r, {
      open: at(0.1),
      close: at(0.8),
      high: s === 1 ? at(1.3) : c.level,
      low: s === 1 ? c.level : at(1.3),
    });
    expect(findRetest(d, c, defaults, d.provenance.asOf, 'baseline')).toBeDefined();
    expect(findRetest(d, c, defaults, d.provenance.asOf, 'feasible')).toBeUndefined();
    d.daily.push({
      ...r,
      start: r.start + DAY,
      end: r.end + DAY,
      open: at(0.05),
      close: at(0.12),
      high: s === 1 ? at(0.15) : c.level,
      low: s === 1 ? c.level : at(0.15),
    });
    expect(findRetest(d, c, defaults, r.end + DAY, 'feasible')?.end).toBe(r.end + DAY);
  },
);
it.each(['bullish', 'bearish'] as const)(
  'separates %s pre-entry setup failure from post-entry invalidation',
  (direction) => {
    const d = fixture(direction),
      initial = idea(d),
      c = initial.candidate,
      s = direction === 'bullish' ? 1 : -1;
    initial.lastBar = c.breakout.end;
    const close = c.level - s * 0.05 * c.atr;
    d.intraday.unshift({
      start: c.retest!.start,
      end: c.retest!.start + QUARTER,
      open: c.level,
      high: Math.max(c.level, close) + 0.1,
      low: Math.min(c.level, close) - 0.1,
      close,
      volume: 1,
    });
    expect(advance(initial, d, defaults, d.provenance.asOf).idea.state).toBe('invalidated');
    const result = advance(initial, d, defaults, d.provenance.asOf, true, 'state_aware');
    expect(result.idea.state).toBe('entry_triggered');
    const entered = result.idea;
    d.intraday.push({
      ...d.intraday[0]!,
      start: d.provenance.asOf,
      end: d.provenance.asOf + QUARTER,
    });
    expect(
      advance(entered, d, defaults, d.provenance.asOf + QUARTER, true, 'state_aware').idea.state,
    ).toBe('invalidated');
  },
);
it('does not expire revised policies on an out-of-zone close before the confirmation deadline', () => {
  const d = fixture(),
    i = idea(d),
    c = i.candidate;
  Object.assign(d.intraday[0]!, { close: c.level + 1.5 * c.atr, high: c.level + 1.6 * c.atr });
  expect(advance(i, d, defaults, d.provenance.asOf).idea.state).toBe('expired');
  expect(advance(i, d, defaults, d.provenance.asOf, true, 'feasible').idea.state).toBe(
    'setup_ready',
  );
});
it('preserves the default public strategy hash and baseline behavior', () => {
  expect(strategyVersion(defaults)).toBe('br-v1-d6a6f233ba78d35787997a93');
  const d = fixture();
  expect(advance(idea(d), d, defaults, d.provenance.asOf)).toEqual(
    advance(idea(d), d, defaults, d.provenance.asOf, true, 'baseline'),
  );
});
const entry = (): SignalEvent => {
  const d = fixture();
  return advance(idea(d), d, defaults, d.provenance.asOf).events.at(-1)!;
};
it('executes only after source delay, polling, delivery and response, with observed delivery preferred', () => {
  const e = entry();
  e.instrument.market = 'equity';
  e.provenance.delayMinutes = 16;
  const assumptions = structuredClone(entryAssumptions);
  expect(availableAt(e, assumptions)).toBe(
    Math.ceil((e.marketTime + 16 * 60_000) / 300_000) * 300_000 + 120_000,
  );
  const actual = e.marketTime + 40 * 60_000;
  expect(
    availableAt(e, assumptions, {
      sourceObservedAt: e.marketTime + 16 * 60_000,
      detectedAt: e.marketTime + 20 * 60_000,
      deliveredAt: actual,
    }),
  ).toBe(actual + 60_000);
  const model = beginEconomics(e);
  const d = fixture();
  const early = { ...d.intraday[0]!, start: e.marketTime, end: e.marketTime + QUARTER };
  stepEconomics(model, e, early);
  expect(model.cases.every((c) => !c.execution)).toBe(true);
  const permitted = Math.ceil(model.cases[0]!.availableAt / QUARTER) * QUARTER;
  stepEconomics(model, e, {
    ...early,
    start: permitted,
    end: permitted + QUARTER,
    open: e.candidate.entry!,
    high: e.candidate.entry! + 0.1,
    low: e.candidate.entry! - 0.1,
  });
  expect(model.cases[0]!.execution?.entryAt).toBe(permitted);
});
it('freezes cost scenarios and labels unmodeled short availability', () => {
  const e = entry();
  e.direction = 'bearish';
  const config = structuredClone(entryAssumptions),
    model = beginEconomics(e, {}, config);
  config.costs.crypto.feeBps = 0;
  expect(model.assumptions.costs.crypto.feeBps).toBe(60);
  expect(model.conditionalShort).toBe(true);
  expect(model.cases.find((c) => c.name === 'normal:cost3')!.costs.feeBps).toBe(180);
  model.incomplete = 'Missing candle';
  expect(netR(model)).toBeUndefined();
});
function snap(data: Dataset, time: number): Dataset {
  const daily = data.daily.filter((b) => b.end <= time);
  return {
    ...data,
    daily,
    benchmark: data.benchmark.filter((b) => b.end <= time),
    weekly: weeklyBars(daily, data.instrument.market, data.sessions, time),
    intraday: data.intraday.filter((b) => b.end <= time),
  };
}
it('pairs baseline rejections with shadow alternatives and never changes public state or scorecards', () => {
  const store = new Store(':memory:');
  try {
    const d = fixture(),
      c = candidate(d),
      t = c.breakout.end;
    const cohort: EntryCohort = {
      id: 'cohort',
      version: strategyVersion(defaults),
      config: defaults,
      startedAt: t,
      assumptions: entryAssumptions,
      policyVersion: 'daily-entry-research-v1',
    };
    store.db
      .prepare('INSERT INTO entry_cohorts VALUES(?,?,?)')
      .run(cohort.id, t, JSON.stringify(cohort));
    store.set('entry_research_cohort', cohort.id);
    const close = { ...d.intraday[0]!, start: t - QUARTER, end: t };
    d.intraday.unshift(close);
    const research = new EntryResearch(store);
    research.step(cohort, snap(d, t), t, t);
    const opportunities = store.db.prepare('SELECT * FROM entry_opportunities').all();
    expect(opportunities.length).toBe(2);
    expect(store.db.prepare('SELECT * FROM entry_positions').all()).toHaveLength(3);
    expect(store.activeIdeas()).toHaveLength(0);
    expect(store.journal()).toHaveLength(0);
    expect(store.pendingCount()).toBe(0);
    new Scorecard(store).process(t);
    expect(new Scorecard(store).summary().groups.strategy_entry.success).toBe(0);
    expect(entryReport(store, t)).toHaveProperty('mode', 'shadow-only');
    expect(() => store.db.prepare("UPDATE entry_cohorts SET body='{}'").run()).toThrow('immutable');
  } finally {
    store.close();
  }
});
it('starts a new cohort on configuration changes and keeps previous cohorts immutable', () => {
  const store = new Store(':memory:');
  try {
    const research = new EntryResearch(store),
      first = research.cohort(1000);
    expect(new EntryResearch(store).cohort(2000).id).toBe(first.id);
    store.saveStrategy({ ...defaults, minimumRR: 4 });
    const second = research.cohort(3000);
    expect(second.id).not.toBe(first.id);
    expect(research.getCohort(first.id)?.config.minimumRR).toBe(3);
  } finally {
    store.close();
  }
});
it('uses deterministic calendar-week block confidence intervals', () => {
  const samples = Array.from({ length: 35 }, (_, n) => ({
    at: Date.parse('2026-01-01T00:00:00Z') + n * DAY,
    delta: n % 3 ? 0.3 : -0.1,
  }));
  expect(weekBound('cohort', samples)).toEqual(weekBound('cohort', samples));
  expect(weekBound('cohort', samples)?.blocks).toBeGreaterThan(2);
  expect(weekBound('cohort', samples.slice(0, 1))).toBeNull();
});
it('bounds shadow candle work, resumes persisted cursors and respects resource pauses', () => {
  const store = new Store(':memory:');
  try {
    const d = fixture(),
      t = d.intraday[0]!.start;
    const bars = Array.from({ length: 40 }, (_, n) => ({
      ...d.intraday[0]!,
      start: t + n * QUARTER,
      end: t + (n + 1) * QUARTER,
    }));
    store.pin(d.instrument);
    store.cache(d.instrument, '1d', d.daily);
    store.cache(benchmarkFor(d.instrument), '1d', d.benchmark);
    const research = new EntryResearch(store);
    research.process(t);
    store.cache(d.instrument, '15m', bars);
    research.process(t + 40 * QUARTER);
    expect(store.get('entry_research_progress', { steps: 0 }).steps).toBe(48);
    const cursors = () => store.db.prepare('SELECT body FROM entry_research_work').all();
    const first = cursors();
    expect(
      first.some((r) => JSON.parse((r as { body: string }).body).through === t + 16 * QUARTER),
    ).toBe(true);
    store.set('learning_paused', true);
    new EntryResearch(store).process(t + 40 * QUARTER);
    expect(cursors()).toEqual(first);
    store.set('learning_paused', false);
    new EntryResearch(store).process(t + 40 * QUARTER);
    expect(cursors()).not.toEqual(first);
    expect(store.get('entry_research_progress', { steps: 0 }).steps).toBe(48);
    expect(new EntryResearch(store).summary().errors).toEqual([]);
  } finally {
    store.close();
  }
});
