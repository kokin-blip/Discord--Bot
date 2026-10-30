import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.js';
import { crypto, type MarketDataProvider } from '../src/domain.js';
import { DAY, QUARTER, dayStart } from '../src/core/time.js';
import { collectHistory, type ResearchInput } from '../src/entry-research/collector.js';
import { historicalEntries } from '../src/entry-research/historical.js';
import { EntryMeasurements } from '../src/entry-research/measurements.js';
import { Learning } from '../src/learning.js';
import { fixture, idea } from './fixtures.js';
import { advance } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';
import { sampleId } from '../src/learning-observations.js';

it('collects bounded pages, resumes across restarts, and exports credential-free source manifests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entry-collection-'));
  let store = new Store(join(directory, 'cache.sqlite'));
  try {
    const to = dayStart(Date.now()) - DAY,
      from = to - DAY;
    const fetch = vi.fn(
      async (_instrument: unknown, interval: string, start: number, end: number) => {
        const duration = interval === '1d' ? DAY : interval === '1m' ? 60_000 : QUARTER;
        return {
          bars: Array.from({ length: Math.floor((end - start) / duration) }, (_, n) => ({
            start: start + n * duration,
            end: start + (n + 1) * duration,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1,
          })),
        };
      },
    );
    const provider = { barPage: fetch, calendar: async () => [] } as unknown as MarketDataProvider;
    const config = {
      directory,
      instruments: [crypto('BTC-USD')],
      from,
      to,
      resolution: '15m' as const,
      maxPages: 1,
    };
    const first = await collectHistory(store, () => provider, config);
    expect(first.complete).toBe(false);
    expect(first.pagesThisInvocation).toBe(1);
    const firstStart = fetch.mock.calls[0]![2];
    store.close();
    store = new Store(join(directory, 'cache.sqlite'));
    const second = await collectHistory(store, () => provider, { ...config, maxPages: 100 });
    expect(fetch.mock.calls[1]![2]).toBe(firstStart + 299 * DAY);
    expect(second.complete).toBe(true);
    const raw = await readFile(second.manifest, 'utf8'),
      input = JSON.parse(raw) as ResearchInput;
    expect(input.sourcePages.length).toBeGreaterThan(2);
    expect(input.sourcePages.every((p) => /^[a-f0-9]{64}$/.test(p.sha256))).toBe(true);
    expect(raw).not.toMatch(/APCA-API|Authorization|DISCORD_TOKEN|ALPACA_API_SECRET/);
    const count = fetch.mock.calls.length;
    await collectHistory(store, () => provider, config);
    expect(fetch).toHaveBeenCalledTimes(count);
    await expect(collectHistory(store, () => provider, { ...config, to: to + 1 })).rejects.toThrow(
      'SETTINGS_CHANGED',
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it('reserves the historical holdout and never labels a short or partial history sufficient', () => {
  const data = fixture(),
    end = data.provenance.asOf;
  const input: ResearchInput = {
    schema: 'entry-research-input-v1',
    datasets: [data],
    evaluation: {
      from: Date.parse('2023-01-01'),
      to: Date.parse('2026-01-01'),
      universe: 'current_symbols',
    },
    evidence: [],
    executionResolution: '15m',
    coverage: { complete: false, errors: [] },
    sourcePages: [],
  };
  const report = historicalEntries(input);
  expect(report.historicalHoldout.evaluated).toBe(false);
  expect(report.partitions.some((p) => p.partition.name === 'historical_holdout')).toBe(false);
  expect(
    report.partitions.every((p) => p.comparisons.every((c) => !c.sufficientComparisonEvidence)),
  ).toBe(true);
  expect(report.universe).toBe('current_symbols');
  expect(end).toBeLessThan(input.evaluation.to);
});
it('waits for an actual delivery receipt before recording execution-v2 and preserves v1 records', () => {
  const store = new Store(':memory:');
  try {
    const data = fixture(),
      result = advance(idea(data), data, defaults, data.provenance.asOf),
      e = result.events.at(-1)!,
      id = sampleId(e, 'strategy_entry');
    store.saveIdea(result.idea, [e]);
    const measurements = new EntryMeasurements(store);
    measurements.start(id, e);
    measurements.process(e.marketTime + DAY);
    expect(store.db.prepare('SELECT * FROM learning_measurements_v2').all()).toHaveLength(0);
    store.saveReceipt(e.id, 'entries', 'message', e.marketTime + 60_000);
    store.db
      .prepare('INSERT INTO learning_measurements VALUES(?,?)')
      .run(id, JSON.stringify({ schema: 'execution-v1', legacy: true }));
    measurements.process(e.marketTime + 120 * DAY + 1);
    const v2 = store.db
      .prepare('SELECT body FROM learning_measurements_v2 WHERE sample_id=?')
      .get(id) as { body: string };
    expect(JSON.parse(v2.body)).toMatchObject({
      schema: 'execution-v2',
      incomplete: expect.any(String),
    });
    expect(
      store.db.prepare('SELECT body FROM learning_measurements WHERE sample_id=?').get(id),
    ).toEqual({ body: JSON.stringify({ schema: 'execution-v1', legacy: true }) });
    expect(() => store.db.prepare("UPDATE learning_measurements_v2 SET body='{}'").run()).toThrow(
      'immutable',
    );
    expect(() => new Learning(store).promote('state_aware', Date.now())).toThrow(
      'UNKNOWN_EXPERIMENT',
    );
  } finally {
    store.close();
  }
});
