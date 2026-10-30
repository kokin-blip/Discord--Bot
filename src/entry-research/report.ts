import type { Store } from '../sql-store.js';
import { stableId } from '../core/strategy.js';
import { DAY, weekStart } from '../core/time.js';
import {
  EntryResearch,
  entryPolicies,
  type EntryCohort,
  type EntryOpportunity,
  type EntryResult,
} from './engine.js';
import { netR } from './execution.js';

function drawdown(values: number[]) {
  let balance = 0,
    peak = 0,
    maximum = 0;
  for (const v of values) {
    balance += v;
    peak = Math.max(peak, balance);
    maximum = Math.max(maximum, peak - balance);
  }
  return maximum;
}
export function weekBound(id: string, pairs: { at: number; delta: number }[]) {
  const groups = new Map<number, { sum: number; n: number }>();
  for (const p of pairs) {
    const k = weekStart(p.at),
      g = groups.get(k) ?? { sum: 0, n: 0 };
    g.sum += p.delta;
    g.n++;
    groups.set(k, g);
  }
  if (groups.size < 2) return null;
  const blocks = [...groups.values()];
  let seed = Number.parseInt(stableId(id).slice(0, 8), 16) || 1;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const samples: number[] = [];
  for (let b = 0; b < 2000; b++) {
    let sum = 0,
      n = 0;
    for (let i = 0; i < blocks.length; i++) {
      const x = blocks[Math.floor(random() * blocks.length)]!;
      sum += x.sum;
      n += x.n;
    }
    samples.push(sum / n);
  }
  samples.sort((a, b) => a - b);
  return {
    lower: samples[49]!,
    upper: samples[1949]!,
    blocks: blocks.length,
    samples: 2000,
    method:
      'Calendar-week block bootstrap; 97.5% one-sided lower bound for each of two declared comparisons',
  };
}
export function compareEntries(
  cohort: EntryCohort,
  opportunities: EntryOpportunity[],
  results: EntryResult[],
  now: number,
  intervals = true,
) {
  const eligible = opportunities.filter((o) => o.eligible),
    byId = new Map(results.map((r) => [`${r.opportunityId}:${r.policy}`, r]));
  const counts: Record<string, { attempted: number; failed: number }> = {};
  for (const o of opportunities)
    for (const c of o.checks) {
      const row = counts[c.name] ?? { attempted: 0, failed: 0 };
      row.attempted++;
      if (!c.passed) row.failed++;
      counts[c.name] = row;
    }
  const policies = entryPolicies.map((policy) => {
    const rows = results.filter((r) => r.policy === policy),
      known = rows.filter((r) => r.netR !== undefined),
      entries = known.filter((r) => r.enteredAt !== undefined),
      ordered = [...known].sort((a, b) => a.resolvedAt - b.resolvedAt || a.id.localeCompare(b.id));
    const totalR = known.reduce((s, r) => s + r.netR!, 0);
    const scenarios = Object.fromEntries(
      ['normal', 'zero_delay', 'slow_response'].flatMap((t) =>
        [1, 2, 3].map((cost) => {
          const key = `${t}:cost${cost}`;
          const values = rows.map((r) =>
            r.economics ? netR(r.economics, key) : r.netR === 0 ? 0 : undefined,
          );
          return [
            key,
            {
              totalR: values.reduce<number>((s, v) => s + (v ?? 0), 0),
              covered: values.filter((v) => v !== undefined).length,
              unknown: values.filter((v) => v === undefined).length,
            },
          ];
        }),
      ),
    );
    const groups = Object.fromEntries(
      (['equity', 'crypto'] as const).flatMap((market) =>
        (['bullish', 'bearish'] as const).map((direction) => {
          const group = known.filter((r) => r.market === market && r.direction === direction);
          return [
            `${market}:${direction}`,
            {
              resolved: group.length,
              entries: group.filter((r) => r.enteredAt !== undefined).length,
              totalR: group.reduce((s, r) => s + r.netR!, 0),
              conditionalShort: direction === 'bearish',
            },
          ];
        }),
      ),
    );
    return {
      policy,
      resolved: rows.length,
      known: known.length,
      unknown: rows.length - known.length,
      pending: Math.max(0, eligible.length - rows.length),
      entered: entries.length,
      entryDays: new Set(entries.map((r) => new Date(r.enteredAt!).toISOString().slice(0, 10)))
        .size,
      executionCoverage: rows.some((r) => r.enteredAt !== undefined)
        ? entries.length / rows.filter((r) => r.enteredAt !== undefined).length
        : 0,
      entriesPer30Days: (entries.length / Math.max(1, (now - cohort.startedAt) / DAY)) * 30,
      simulatedTrades: entries.filter(
        (r) =>
          r.economics?.cases.find((c) => c.name === 'normal:cost1')?.execution?.status === 'closed',
      ).length,
      closeBasedSignals: {
        outcomes: Object.fromEntries(
          [...new Set(rows.map((r) => r.outcome))].map((o) => [
            o,
            rows.filter((r) => r.outcome === o).length,
          ]),
        ),
        grossR: rows.reduce((s, r) => s + (r.signalPerformance?.rMultiple ?? 0), 0),
        covered: rows.filter((r) => r.signalPerformance).length,
        ambiguous: rows.filter((r) => r.signalPerformance?.ambiguous).length,
        basis: 'Completed-close signal measurements, separate from protective-stop simulations',
      },
      totalR,
      netRPerOpportunity: known.length ? totalR / known.length : null,
      netRPerEnteredTrade: entries.length
        ? entries.reduce((s, r) => s + r.netR!, 0) / entries.length
        : null,
      drawdownR: drawdown(ordered.map((r) => r.netR!)),
      scenarios,
      groups,
    };
  });
  const comparisons = entryPolicies
    .filter((p) => p !== 'baseline')
    .map((policy) => {
      const paired = eligible
        .map((o) => ({ o, a: byId.get(`${o.id}:baseline`), b: byId.get(`${o.id}:${policy}`) }))
        .filter((p) => p.a?.netR !== undefined && p.b?.netR !== undefined);
      const a = policies[0]!,
        b = policies.find((p) => p.policy === policy)!;
      const confidence = intervals
        ? weekBound(
            `${cohort.id}:${policy}`,
            paired.map((p) => ({ at: p.o.at, delta: p.b!.netR! - p.a!.netR! })),
          )
        : null;
      const blockers = [
        now - cohort.startedAt < 56 * DAY ? 'FIFTY_SIX_DAYS_REQUIRED' : undefined,
        a.entered < 100 || b.entered < 100
          ? 'ONE_HUNDRED_RESOLVED_ENTRIES_PER_POLICY_REQUIRED'
          : undefined,
        a.entryDays < 20 || b.entryDays < 20 ? 'TWENTY_ENTRY_DAYS_REQUIRED' : undefined,
        a.executionCoverage < 0.9 || b.executionCoverage < 0.9
          ? 'NINETY_PERCENT_EXECUTION_COVERAGE_REQUIRED'
          : undefined,
        paired.length < eligible.length * 0.9 ? 'PAIRED_COVERAGE_INSUFFICIENT' : undefined,
      ].filter(Boolean);
      return {
        policy,
        paired: paired.length,
        meanDeltaR: paired.length
          ? paired.reduce((s, p) => s + p.b!.netR! - p.a!.netR!, 0) / paired.length
          : null,
        missedWinners: paired.filter((p) => p.a!.netR! > 0 && p.b!.netR === 0).length,
        missedWinnerR: paired.reduce(
          (s, p) => s + (p.a!.netR! > 0 && p.b!.netR === 0 ? p.a!.netR! : 0),
          0,
        ),
        confidence,
        sufficientComparisonEvidence: !blockers.length,
        blockers,
      };
    });
  return {
    schema: 'entry-research-report-v1',
    cohort,
    checkedAt: now,
    opportunities: opportunities.length,
    eligibleOpportunities: eligible.length,
    rejectionFunnel: counts,
    policies,
    comparisons,
    limitations: [
      'Shadow-only research; no automatic activation or realized profit.',
      'Each opportunity counts once per policy. No-entry is zero; missing observations are unknown.',
      'Short simulations are conditional: borrow, funding and short availability are unmodeled.',
      'Costs are frozen illustrative scenarios; slippage includes spread assumptions.',
      'R totals assume comparable risk per opportunity and do not model a funded portfolio.',
      'Historical revised data and modeled availability are not proof of real-time reproducibility.',
    ],
  };
}
export function entryReport(store: Store, now = Date.now()) {
  const engine = new EntryResearch(store),
    summary = engine.summary(now),
    cohort = summary.cohort;
  if (!cohort) return { ...summary, note: 'Waiting for the first eligible coordinator tick.' };
  const opportunities = (
    store.db
      .prepare('SELECT body FROM entry_opportunities WHERE cohort_id=? ORDER BY at,id LIMIT 5001')
      .all(cohort.id) as { body: string }[]
  ).map((r) => JSON.parse(r.body) as EntryOpportunity);
  const results = (
    store.db
      .prepare('SELECT body FROM entry_results WHERE cohort_id=? ORDER BY id LIMIT 15001')
      .all(cohort.id) as { body: string }[]
  ).map((r) => JSON.parse(r.body) as EntryResult);
  const truncated = opportunities.length > 5000 || results.length > 15000;
  const report = compareEntries(cohort, opportunities.slice(0, 5000), results.slice(0, 15000), now);
  if (truncated)
    for (const c of report.comparisons) {
      c.sufficientComparisonEvidence = false;
      c.blockers.push('REPORT_EXPORT_LIMIT_REACHED');
    }
  return { ...summary, ...report, truncated };
}
