import { Store } from '../storage.js';
import type { Bar, Dataset } from '../domain.js';
import { defaults, strategySchema, type StrategyConfig } from '../config.js';
import { DAY, QUARTER, expectedIntraday, validateBars, weeklyBars } from '../core/time.js';
import { checkDaily, checkIntraday } from '../core/quality.js';
import { stableId, strategyVersion } from '../core/strategy.js';
import {
  EntryResearch,
  type EntryCohort,
  type EntryOpportunity,
  type EntryResult,
} from './engine.js';
import { entryAssumptions } from './execution.js';
import { compareEntries } from './report.js';
import type { ResearchInput } from './collector.js';

function month(time: number, offset: number) {
  const d = new Date(time);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return +d;
}
function upper(bars: Bar[], time: number) {
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.end <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function recent(bars: Bar[], time: number, days: number) {
  return bars.slice(upper(bars, time - days * DAY), upper(bars, time));
}
export function historicalEntries(
  input: ResearchInput,
  configuration: StrategyConfig = defaults,
  includeHoldout = false,
) {
  const config = strategySchema.parse(configuration),
    from = input.evaluation.from,
    to = input.evaluation.to;
  if (
    input.schema !== 'entry-research-input-v1' ||
    !input.datasets.length ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to
  )
    throw new Error('INVALID_ENTRY_RESEARCH_INPUT');
  if (new Set(input.datasets.map((d) => d.instrument.id)).size !== input.datasets.length)
    throw new Error('DUPLICATE_RESEARCH_INSTRUMENT');
  if (
    input.evaluation.universe === 'point_in_time' &&
    (!input.evaluation.eligibility?.length ||
      input.evaluation.eligibility.some(
        (e) =>
          !input.datasets.some((d) => d.instrument.id === e.instrumentId) ||
          !Number.isFinite(e.from) ||
          !Number.isFinite(e.to) ||
          e.from >= e.to,
      ))
  )
    throw new Error('INVALID_ELIGIBILITY_MANIFEST');
  const holdoutStart = month(to, -6),
    validationStart = month(from, 18);
  const end = includeHoldout ? to : Math.min(to, holdoutStart);
  const store = new Store(':memory:');
  try {
    const cohort: EntryCohort = {
      id: stableId('historical-entry-v1', config, input.evidence, from, to),
      version: strategyVersion(config),
      config,
      startedAt: from,
      assumptions: {
        ...structuredClone(entryAssumptions),
        resolutionMs: input.executionResolution === '1m' ? 60_000 : QUARTER,
      },
      policyVersion: 'daily-entry-research-v1',
    };
    store.db
      .prepare('INSERT INTO entry_cohorts VALUES(?,?,?)')
      .run(cohort.id, from, JSON.stringify(cohort));
    const engine = new EntryResearch(store),
      issues: { symbol: string; at: number; reason: string }[] = [];
    for (const d of input.datasets)
      for (const bars of [
        d.daily,
        d.benchmark,
        d.intraday,
        input.executionBars?.[d.instrument.id] ?? [],
      ])
        validateBars(bars);
    const timeline = input.datasets
      .flatMap((data, index) =>
        data.intraday.filter((b) => b.end >= from && b.end <= end).map((bar) => ({ index, bar })),
      )
      .sort(
        (a, b) =>
          a.bar.end - b.bar.end ||
          input.datasets[a.index]!.instrument.id.localeCompare(
            input.datasets[b.index]!.instrument.id,
          ),
      );
    const previous = new Map<string, number>();
    for (const { index, bar } of timeline) {
      const source = input.datasets[index]!,
        instrument = source.instrument;
      const data: Dataset = {
        ...source,
        daily: recent(source.daily, bar.end, 800),
        benchmark: recent(source.benchmark, bar.end, 800),
        intraday: recent(source.intraday, bar.end, 35),
        weekly: [],
      };
      data.weekly = weeklyBars(data.daily, instrument.market, data.sessions, bar.end);
      const previousEnd = previous.get(instrument.id) ?? bar.start;
      previous.set(instrument.id, bar.end);
      try {
        checkDaily(instrument, data.daily, data.sessions, bar.end);
        checkDaily(instrument, data.benchmark, data.sessions, bar.end);
        checkIntraday(data, previousEnd, bar.end);
        let executionBars: Bar[] | undefined;
        if (input.executionResolution === '1m') {
          const all = input.executionBars?.[instrument.id] ?? [];
          executionBars = all.slice(upper(all, bar.start), upper(all, bar.end));
          const starts = new Set(executionBars.map((b) => b.start));
          if (
            executionBars.some((b) => b.end - b.start !== 60_000) ||
            !Array.from({ length: 15 }, (_, n) => bar.start + n * 60_000).every((t) =>
              starts.has(t),
            )
          )
            throw new Error('MISSING_ONE_MINUTE_EXECUTION_BARS');
        }
        const enroll =
          input.evaluation.universe !== 'point_in_time' ||
          !!input.evaluation.eligibility?.some(
            (e) => e.instrumentId === instrument.id && e.from <= bar.end && e.to > bar.end,
          );
        engine.step(cohort, data, bar.end, bar.end, enroll, 'modeled', executionBars);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'RESEARCH_HISTORY_UNAVAILABLE';
        if (issues.length < 100) issues.push({ symbol: instrument.symbol, at: bar.end, reason });
        engine.unavailable(cohort.id, instrument.id, bar.end, reason);
      }
    }
    const opportunities = (
      store.db.prepare('SELECT body FROM entry_opportunities ORDER BY at,id').all() as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body) as EntryOpportunity);
    const results = (
      store.db.prepare('SELECT body FROM entry_results ORDER BY id').all() as { body: string }[]
    ).map((r) => JSON.parse(r.body) as EntryResult);
    const partitions = [
      { name: 'development', start: from, end: Math.min(validationStart, end) },
      ...[0, 1, 2, 3].map((n) => ({
        name: `validation_${n + 1}`,
        start: month(validationStart, 3 * n),
        end: Math.min(month(validationStart, 3 * (n + 1)), holdoutStart),
      })),
      ...(includeHoldout ? [{ name: 'historical_holdout', start: holdoutStart, end: to }] : []),
    ].filter((p) => p.end > p.start);
    return {
      schema: 'historical-entry-report-v1',
      cohort,
      availability: 'modeled; retrospectively retrieved source snapshots',
      universe: input.evaluation.universe,
      coverage: input.coverage,
      issues,
      splitCoverage:
        to >= month(from, 36)
          ? '36-month design available'
          : 'Short history: full 18/12/6-month design unavailable',
      historicalHoldout: { from: holdoutStart, to, evaluated: includeHoldout },
      partitions: partitions.map((partition) => {
        const enrolled = opportunities.filter(
          (o) => o.at >= partition.start && o.at < partition.end,
        );
        const ids = new Set(enrolled.map((o) => o.id));
        // Purge the entire opportunity when any policy's label crosses a partition boundary.
        const crossing = new Set(
          results
            .filter((r) => ids.has(r.opportunityId) && r.resolvedAt >= partition.end)
            .map((r) => r.opportunityId),
        );
        for (const o of enrolled)
          if (
            ['baseline', 'feasible', 'state_aware'].some(
              (p) => !results.some((r) => r.opportunityId === o.id && r.policy === p),
            )
          )
            crossing.add(o.id);
        const report = compareEntries(
          cohort,
          enrolled.filter((o) => !crossing.has(o.id)),
          results.filter((r) => ids.has(r.opportunityId) && !crossing.has(r.opportunityId)),
          partition.end,
        );
        for (const comparison of report.comparisons) {
          comparison.sufficientComparisonEvidence = false;
          comparison.blockers.push('PROSPECTIVE_COHORT_REQUIRED');
          if (issues.length || !input.coverage.complete)
            comparison.blockers.push('HISTORICAL_COVERAGE_INCOMPLETE');
        }
        return { partition, purgedOverlappingOpportunities: crossing.size, ...report };
      }),
      limitations: [
        'Historical analysis does not satisfy prospective activation evidence.',
        'Current-symbol datasets have selection/survivorship limitations unless an eligibility manifest is supplied.',
        'A selected policy still requires prospective observation and a separate future activation release.',
      ],
    };
  } finally {
    store.close();
  }
}
