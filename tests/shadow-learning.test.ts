import { expect, it, vi } from 'vitest';
import { Store } from '../src/storage.js';
import { Learning } from '../src/learning.js';
import { ShadowLearning, type OutcomeSample } from '../src/shadow-learning.js';
import { DailyRecap } from '../src/daily-recap.js';
import { advance } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';
import { fixture, idea } from './fixtures.js';
import type { SignalEvent } from '../src/domain.js';
const DAY = 86_400_000;
const start = Date.parse('2026-01-01T12:00:00-07:00');
function event(id: string, at: number): SignalEvent {
  const data = fixture();
  const e = structuredClone(
    advance(idea(data), data, defaults, data.provenance.asOf).events.at(-1)!,
  );
  Object.assign(e, { id, ideaId: id, marketTime: at, recordedAt: at, recovery: false });
  e.learning = { at, benchmarkTrend: 'up', benchmarkAgreement: true, close: 100, atr: 2 };
  return e;
}
function seed(store: Store, n = 120) {
  const shadow = new ShadowLearning(store);
  for (let i = 0; i < n; i++) {
    const callout = event(`sample-${i}`, start + i * DAY);
    callout.learning!.breakoutRelativeVolume = i % 2 ? 5 : 0.1;
    shadow.record({
      id: callout.id,
      family: 'strategy_entry',
      callout,
      terminal: { ...callout, state: i % 2 ? 'final_target' : 'invalidated' },
      features: callout.learning!,
      outcome: i % 2 ? 'success' : 'failure',
      resolved: callout.marketTime + 900000,
      observedAt: callout.marketTime + 900000,
    });
  }
}
it('journals ordinary successes and uncertain outcomes once, retaining original features and terminal performance', () => {
  const store = new Store(':memory:');
  try {
    for (const [id, state, ambiguous] of [
      ['ordinary', 'time_exit', false],
      ['uncertain', 'invalidated', true],
      ['expired', 'expired', false],
    ] as const) {
      const e = event(id, start);
      store.recordEvent(e);
      store.recordEvent({
        ...e,
        id: `end-${id}`,
        state,
        marketTime: start + 900000,
        performance: {
          referencePrice: 100,
          changePercent: 1,
          rMultiple: 0.5,
          reachedTargets: [],
          basis: 'completed_close',
          ambiguous,
        },
      });
    }
    const learning = new Learning(store);
    learning.process(start + DAY);
    learning.process(start + DAY);
    const samples = (
      store.db.prepare('SELECT body FROM learning_journal').all() as { body: string }[]
    ).map((r) => JSON.parse(r.body) as OutcomeSample);
    expect(samples.map((s) => s.outcome).sort()).toEqual(['ambiguous', 'success', 'unconfirmed']);
    expect(samples[0]!.features.at).toBe(start);
    expect(samples[0]!.terminal.performance!.rMultiple).toBe(0.5);
    expect(() => store.db.exec('UPDATE learning_journal SET resolved=0')).toThrow('append-only');
    expect(() => store.db.exec('DELETE FROM learning_journal')).toThrow('append-only');
  } finally {
    store.close();
  }
});
it('trains a bounded daily model with chronological validation, preserves versions and never changes live rules', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const shadow = new ShadowLearning(store),
      now = start + 121 * DAY;
    const before = store.strategy();
    shadow.daily(now);
    expect(shadow.report()).toContain('trained on 95, validated on 24');
    const models = store.db.prepare('SELECT body FROM learning_models').all() as { body: string }[];
    expect(models).toHaveLength(1);
    const model = JSON.parse(models[0]!.body);
    expect(model.validation.brier).toBeLessThan(model.validation.baselineBrier);
    shadow.daily(now + 1000);
    expect(store.db.prepare('SELECT body FROM learning_models').all()).toHaveLength(1);
    expect(store.strategy()).toEqual(before);
    expect(() => new Learning(store).promote(model.id, now + 30 * DAY)).toThrow();
    expect(() => store.db.exec("UPDATE learning_models SET day='changed'")).toThrow('immutable');
    const high = event('next', now + 900000);
    high.learning!.breakoutRelativeVolume = 5;
    const low = structuredClone(high);
    low.learning!.breakoutRelativeVolume = 0.1;
    expect(shadow.score(high, 'strategy_entry')!.score).toBeGreaterThan(
      shadow.score(low, 'strategy_entry')!.score,
    );
    expect(shadow.score({ ...high, marketTime: now }, 'strategy_entry')).toBeUndefined();
    expect(shadow.score({ ...high, recordedAt: now - DAY }, 'strategy_entry')).toBeUndefined();
    expect(shadow.score({ ...high, recovery: true }, 'strategy_entry')).toBeUndefined();
    expect(
      shadow.score({ ...high, strategyVersion: 'different' }, 'strategy_entry'),
    ).toBeUndefined();
    shadow.daily(now + DAY);
    expect(store.db.prepare('SELECT body FROM learning_models').all()).toHaveLength(2);
    expect(store.db.prepare('SELECT body FROM learning_models').all()[0]).toEqual(models[0]);
  } finally {
    store.close();
  }
});
it('does not train from overlapping windows, later-known outcomes, or insufficient class evidence', () => {
  for (const reason of ['overlap', 'late', 'single-class'] as const) {
    const store = new Store(':memory:');
    try {
      const shadow = new ShadowLearning(store);
      for (let i = 0; i < 120; i++) {
        const e = event(`${reason}-${i}`, start + i * DAY);
        shadow.record({
          id: e.id,
          family: 'strategy_entry',
          callout: e,
          terminal: e,
          features: e.learning!,
          outcome: reason === 'single-class' ? 'success' : i % 2 ? 'success' : 'failure',
          resolved: reason === 'overlap' ? start + 120 * DAY : e.marketTime + 900000,
          observedAt: reason === 'late' ? start + 120 * DAY : e.marketTime + 900000,
        });
      }
      shadow.daily(start + 121 * DAY);
      expect(store.db.prepare('SELECT body FROM learning_models').all()).toHaveLength(0);
      expect(shadow.report()).toContain('insufficient chronological evidence');
    } finally {
      store.close();
    }
  }
});
it('excludes future, replay, uncertain and obsolete-version samples from training', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const shadow = new ShadowLearning(store),
      now = start + 121 * DAY;
    for (const reason of ['future', 'replay', 'uncertain', 'obsolete'] as const) {
      const e = event(reason, start + 50 * DAY);
      if (reason === 'replay') e.recovery = true;
      if (reason === 'obsolete') e.strategyVersion = 'old-version';
      shadow.record({
        id: e.id,
        family: 'strategy_entry',
        callout: e,
        terminal: e,
        features: e.learning!,
        outcome: reason === 'uncertain' ? 'unknown' : 'failure',
        resolved: reason === 'future' ? now + DAY : e.marketTime + 900000,
        observedAt: e.marketTime + 900000,
      });
    }
    shadow.daily(now);
    expect(shadow.report()).toContain('trained on 95, validated on 24');
  } finally {
    store.close();
  }
});
it('freezes prospective scores through retraining and reports only delivered calls with their original model', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const shadow = new ShadowLearning(store),
      now = start + 121 * DAY;
    shadow.daily(now);
    new DailyRecap(store).initialize(now);
    const e = event('live-shadow', now + 900000);
    e.learning!.breakoutRelativeVolume = 0.1;
    const original = shadow.score(e, 'strategy_entry')!;
    store.enqueue(e, 'equity_ideas');
    store.saveReceipt(e.id, 'channel', 'message');
    store.delivered(e.id);
    new Learning(store).process(e.marketTime);
    shadow.daily(now + DAY);
    const terminal = {
      ...e,
      id: 'terminal-shadow',
      state: 'invalidated' as const,
      marketTime: now + DAY + 900000,
      recordedAt: now + DAY + 900000,
    };
    store.recordEvent(terminal);
    new Learning(store).process(terminal.marketTime);
    const row = store.db
      .prepare("SELECT body FROM learning_journal WHERE id NOT LIKE 'sample-%'")
      .get() as { body: string };
    expect((JSON.parse(row.body) as OutcomeSample).shadow).toEqual(original);
    for (let tick = 0; tick < 3; tick++) new Learning(store).process(now + 2 * DAY);
    const recap = store
      .journal()
      .find((x) => x.announcement?.body.includes('prospective shadow scores'));
    expect(recap!.announcement!.body).toContain(original.modelId);
    expect(recap!.announcement!.body).toContain('exclude 1 failed and 0 successful');
    expect(store.strategy()).toEqual(defaults);
  } finally {
    store.close();
  }
});

it('rolls back journal resolution and retries without duplicate observations', () => {
  const store = new Store(':memory:');
  try {
    const e = event('atomic', start);
    store.recordEvent(e);
    store.recordEvent({ ...e, id: 'atomic-end', state: 'invalidated', marketTime: start + 900000 });
    const fail = vi.spyOn(DailyRecap.prototype, 'record').mockImplementationOnce(() => {
      throw new Error('interrupted');
    });
    expect(() => new Learning(store).process(start + DAY)).toThrow('interrupted');
    expect(store.db.prepare('SELECT body FROM learning_journal').all()).toHaveLength(0);
    expect(new Learning(store).status().pending).toBe(1);
    fail.mockRestore();
    new Learning(store).process(start + DAY);
    expect(store.db.prepare('SELECT body FROM learning_journal').all()).toHaveLength(1);
    expect(new Learning(store).status().pending).toBe(0);
  } finally {
    vi.restoreAllMocks();
    store.close();
  }
});
it('rolls back interrupted daily model publication and respects learning budget pauses', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const now = start + 121 * DAY;
    store.set('learning_paused', true);
    new Learning(store).process(now);
    expect(store.get('shadow_learning_day', null)).toBeNull();
    store.set('learning_paused', false);
    const original = store.set.bind(store);
    const fail = vi.spyOn(store, 'set').mockImplementation((key, value) => {
      if (key === 'shadow_learning_day') throw new Error('interrupted');
      original(key, value);
    });
    expect(() => new ShadowLearning(store).daily(now)).toThrow('interrupted');
    expect(store.db.prepare('SELECT body FROM learning_models').all()).toHaveLength(0);
    expect(store.db.prepare('SELECT body FROM learning_model_reports').all()).toHaveLength(0);
    fail.mockRestore();
    new ShadowLearning(store).daily(now);
    expect(store.db.prepare('SELECT body FROM learning_models').all()).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    store.close();
  }
});
