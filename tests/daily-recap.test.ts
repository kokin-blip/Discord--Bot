import { expect, it } from 'vitest';
import { Store } from '../src/storage.js';
import { DailyRecap, phoenixDay } from '../src/daily-recap.js';
import { Learning, type Experiment } from '../src/learning.js';
import { fixture, idea } from './fixtures.js';
import { advance } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';
import type { SignalEvent } from '../src/domain.js';
const start = Date.parse('2026-10-08T00:00:00-07:00');
const end = start + 86_400_000;
function call(store: Store, id: string, time = start + 60_000, delivered = true): SignalEvent {
  const data = fixture();
  const e = structuredClone(
    advance(idea(data), data, defaults, data.provenance.asOf).events.at(-1)!,
  );
  Object.assign(e, { id, ideaId: id, marketTime: time, recordedAt: time, recovery: false });
  e.learning = { at: time, benchmarkTrend: 'up', benchmarkAgreement: true };
  store.enqueue(e, 'equity_ideas');
  if (delivered) {
    store.saveReceipt(e.id, 'channel', `message-${id}`);
    store.delivered(e.id);
  }
  return e;
}
const recaps = (store: Store) =>
  store.journal().filter((e) => e.announcement?.title.startsWith('Daily callout recap'));
it('uses Phoenix midnight, includes zero days, and catches up once per tick after restart', () => {
  const store = new Store(':memory:');
  try {
    const daily = new DailyRecap(store);
    daily.initialize(start);
    expect(phoenixDay(end - 1)).toBe('2026-10-08');
    daily.queue(end - 1);
    expect(recaps(store)).toHaveLength(0);
    daily.queue(end);
    new DailyRecap(store).queue(end);
    expect(recaps(store)).toHaveLength(1);
    expect(recaps(store)[0]!.announcement!.body).toContain('0 right · 0 wrong');
    expect(store.pending(end)[0]!.route).toBe('summaries');
    daily.queue(end + 3 * 86_400_000);
    expect(recaps(store)).toHaveLength(2);
  } finally {
    store.close();
  }
});
it('separates families, includes only receipts, deduplicates, and reports late results once', () => {
  const store = new Store(':memory:');
  try {
    const daily = new DailyRecap(store);
    daily.initialize(start);
    const a = call(store, 'a');
    const b = call(store, 'b');
    const resolution = {
      family: 'strategy_entry' as const,
      outcome: 'failure' as const,
      experiments: [],
    };
    const terminal = { ...a, marketTime: start + 120_000, recordedAt: start + 120_000 };
    daily.record(a, terminal, resolution);
    daily.record(a, terminal, resolution);
    daily.record(b, terminal, { ...resolution, family: 'strategy_setup', outcome: 'success' });
    daily.record(call(store, 'ambiguous'), terminal, { ...resolution, outcome: 'ambiguous' });
    daily.record({ ...a, id: 'synthetic', debug: true }, terminal, resolution);
    daily.record({ ...a, id: 'recovery', recovery: true }, terminal, resolution);
    store.recordEvent({ ...a, id: 'unpublished' });
    daily.record({ ...a, id: 'unpublished' }, terminal, resolution);
    daily.queue(end);
    const body = recaps(store)[0]!.announcement!.body;
    expect(body).toContain('0 right · 1 wrong');
    expect(body).toContain('1 qualified · 0 failed');
    expect(body).toContain('ambiguous 1');
    const late = call(store, 'late');
    daily.record(late, { ...terminal, recordedAt: end + 10_000 }, resolution);
    daily.queue(end + 86_400_000);
    expect(recaps(store)[1]!.announcement!.body).toContain('Includes 1 delayed outcomes');
    daily.queue(end + 2 * 86_400_000);
    expect(recaps(store)[2]!.announcement!.body).toContain('0 right · 0 wrong');
  } finally {
    store.close();
  }
});
it('waits for source delivery, preserves atomic queue state on failure, and discloses processing gaps', () => {
  const store = new Store(':memory:');
  try {
    const daily = new DailyRecap(store);
    daily.initialize(start);
    const e = call(store, 'waiting', start + 60_000, false);
    daily.record(e, e, { family: 'strategy_entry', outcome: 'unknown', experiments: [] });
    daily.queue(end);
    expect(recaps(store)).toHaveLength(0);
    store.saveReceipt(e.id, 'channel', 'message');
    store.delivered(e.id);
    store.set('last_error', 'PROVIDER_UNAVAILABLE');
    store.db.exec(
      "CREATE TRIGGER reject_recap BEFORE INSERT ON events WHEN json_extract(NEW.body,'$.strategyVersion')='system' BEGIN SELECT RAISE(ABORT,'failed'); END;",
    );
    expect(() => daily.queue(end)).toThrow('failed');
    expect(store.get('daily_recap_next', '')).toBe('2026-10-08');
    store.db.exec('DROP TRIGGER reject_recap');
    daily.queue(end);
    expect(recaps(store)[0]!.announcement!.body).toContain('unknown 1');
    expect(recaps(store)[0]!.announcement!.body).toContain('Data/processing warning');
  } finally {
    store.close();
  }
});
it('persists multiple dated learning changes and balanced shadow evidence', () => {
  const store = new Store(':memory:');
  try {
    const daily = new DailyRecap(store);
    daily.initialize(start);
    const counts = { success: 0, failure: 0, ambiguous: 0, unknown: 0, unconfirmed: 0 };
    const experiment: Experiment = {
      id: 'experiment',
      filter: 'volume025',
      family: 'strategy_entry',
      version: 'v1',
      proposedAt: start,
      status: 'shadow',
      pass: counts,
      blocked: counts,
      evidence: { eligible: 20, failures: 5, difference: 0.2 },
    };
    daily.activity(experiment, 'started shadow testing a possible improvement', start + 1000);
    daily.activity(
      { ...experiment, promotedVersion: 'v2' },
      'manager-approved promotion',
      start + 2000,
    );
    daily.activity(experiment, 'manager-approved rollback', start + 3000);
    for (const [id, outcome, pass] of [
      ['fail', 'failure', false],
      ['success', 'success', false],
      ['retain', 'success', true],
    ] as const) {
      const e = call(store, id);
      daily.record(e, e, {
        family: 'strategy_entry',
        outcome,
        experiments: [{ id: experiment.id, pass }],
      });
    }
    daily.queue(end);
    const body = recaps(store)[0]!.announcement!.body;
    expect(body).toContain('started shadow testing');
    expect(body).toContain('manager-approved promotion');
    expect(body).toContain('manager-approved rollback');
    expect(body).toContain('excluded 1 failed and 1 successful');
    expect(body).toContain('retained 1 outcomes');
    expect(body).toContain('not demonstrated live improvement');
  } finally {
    store.close();
  }
});
it('integrates learning resolution with bounded backlog and pause handling', () => {
  const store = new Store(':memory:');
  try {
    const learning = new Learning(store);
    learning.process(start);
    const e = call(store, 'entry');
    store.recordEvent({
      ...e,
      id: 'terminal',
      state: 'invalidated',
      marketTime: start + 120_000,
      recordedAt: start + 120_000,
    });
    learning.process(end, 1);
    expect(recaps(store)).toHaveLength(0);
    store.set('learning_paused', true);
    learning.process(end);
    expect(recaps(store)).toHaveLength(0);
    store.set('learning_paused', false);
    learning.process(end);
    learning.process(end);
    expect(recaps(store)[0]!.announcement!.body).toContain('0 right · 1 wrong');
    learning.process(end);
    expect(recaps(store)).toHaveLength(1);
  } finally {
    store.close();
  }
});
