import type { Bar, Candidate, Dataset, Idea, Instrument, SignalEvent } from '../domain.js';
import { benchmarkFor, terminalStates } from '../domain.js';
import type { Store } from '../sql-store.js';
import type { StrategyConfig } from '../config.js';
import {
  advance,
  detect,
  findRetest,
  stableId,
  strategyVersion,
  type EntryPolicy,
  type QualificationAttempt,
} from '../core/strategy.js';
import { DAY, sessionsAfter, weeklyBars } from '../core/time.js';
import { checkDaily, checkIntraday } from '../core/quality.js';
import {
  beginEconomics,
  entryAssumptions,
  finishEconomics,
  netR,
  stepEconomics,
  type EntryAssumptions,
  type EntryEconomics,
} from './execution.js';
import { sourceObservedAt } from './timing.js';

export const entryPolicies: EntryPolicy[] = ['baseline', 'feasible', 'state_aware'];
export interface EntryCohort {
  id: string;
  version: string;
  config: StrategyConfig;
  startedAt: number;
  assumptions: EntryAssumptions;
  policyVersion: 'daily-entry-research-v1';
}
interface Work {
  instrument: Instrument;
  through: number;
  revision: number;
  benchmarkRevision?: number;
  missing?: string;
}
export interface EntryOpportunity {
  id: string;
  cohortId: string;
  instrument: Instrument;
  at: number;
  observedAt: number;
  direction: 'bullish' | 'bearish';
  checks: QualificationAttempt['checks'];
  eligible: boolean;
}
export interface EntryPosition {
  id: string;
  opportunityId: string;
  cohortId: string;
  instrument: Instrument;
  policy: EntryPolicy;
  idea?: Idea;
  state: string;
  entry?: SignalEvent;
  economics?: EntryEconomics;
  reason?: string;
  terminalAt?: number;
  terminalState?: string;
  signalPerformance?: SignalEvent['performance'];
}
export interface EntryResult {
  id: string;
  opportunityId: string;
  policy: EntryPolicy;
  market: Instrument['market'];
  direction: 'bullish' | 'bearish';
  at: number;
  resolvedAt: number;
  enteredAt?: number;
  outcome: string;
  reason?: string;
  economics?: EntryEconomics;
  netR?: number;
  signalPerformance?: SignalEvent['performance'];
}

function dataset(store: Store, instrument: Instrument, time: number): Dataset {
  const sessions =
    instrument.market === 'equity'
      ? store.get<{ rows: Dataset['sessions'] }>('calendar', { rows: [] }).rows
      : [];
  const daily = store.bars(instrument, '1d').filter((b) => b.end <= time);
  return {
    instrument,
    daily,
    intraday: store.bars(instrument, '15m').filter((b) => b.end <= time),
    benchmark: store.bars(benchmarkFor(instrument), '1d').filter((b) => b.end <= time),
    sessions,
    weekly: weeklyBars(daily, instrument.market, sessions, time),
    provenance: {
      provider: 'Cached observed market history',
      feed: instrument.venue,
      delayMinutes: instrument.market === 'equity' ? 16 : 0,
      asOf: time,
    },
  };
}

export class EntryResearch {
  private detection = new Map<
    string,
    { attempts: QualificationAttempt[]; candidates: Candidate[] }
  >();
  constructor(readonly store: Store) {}
  cohort(now: number): EntryCohort {
    const config = this.store.strategy(),
      version = strategyVersion(config);
    const active = this.store.get<string | null>('entry_research_cohort', null);
    const old = active ? this.getCohort(active) : undefined;
    if (old?.version === version) return old;
    const cohort: EntryCohort = {
      id: stableId('entry-cohort-v1', version, now),
      version,
      config,
      startedAt: now,
      assumptions: structuredClone(entryAssumptions),
      policyVersion: 'daily-entry-research-v1',
    };
    this.store.transaction(() => {
      this.store.db
        .prepare('INSERT OR IGNORE INTO entry_cohorts VALUES(?,?,?)')
        .run(cohort.id, now, JSON.stringify(cohort));
      this.store.set('entry_research_cohort', cohort.id);
    });
    return cohort;
  }
  getCohort(id: string): EntryCohort | undefined {
    const row = this.store.db.prepare('SELECT body FROM entry_cohorts WHERE id=?').get(id) as
      { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  private positions(cohortId: string): EntryPosition[] {
    return (
      this.store.db
        .prepare(
          "SELECT body FROM entry_positions WHERE cohort_id=? AND state NOT IN ('resolved') ORDER BY id",
        )
        .all(cohortId) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  private save(position: EntryPosition) {
    this.store.db
      .prepare(
        'INSERT INTO entry_positions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body',
      )
      .run(
        position.id,
        position.cohortId,
        position.policy,
        position.state,
        JSON.stringify(position),
      );
  }
  private finish(
    position: EntryPosition,
    opportunity: EntryOpportunity,
    time: number,
    outcome: string,
    reason?: string,
  ) {
    if (position.economics) finishEconomics(position.economics, reason);
    const result: EntryResult = {
      id: position.id,
      opportunityId: opportunity.id,
      policy: position.policy,
      market: opportunity.instrument.market,
      direction: opportunity.direction,
      at: opportunity.at,
      resolvedAt: time,
      enteredAt: position.entry?.marketTime,
      outcome,
      reason,
      economics: position.economics,
      signalPerformance: position.signalPerformance,
      netR: position.entry
        ? netR(position.economics)
        : reason?.startsWith('Missing')
          ? undefined
          : 0,
    };
    this.store.db
      .prepare('INSERT OR IGNORE INTO entry_results VALUES(?,?,?,?)')
      .run(position.id, position.cohortId, position.policy, JSON.stringify(result));
    position.state = 'resolved';
    this.save(position);
  }
  unavailable(cohortId: string, instrumentId: string, time: number, reason: string) {
    for (const p of this.positions(cohortId)) {
      const row = this.store.db
        .prepare('SELECT body FROM entry_opportunities WHERE id=?')
        .get(p.opportunityId) as { body: string };
      const opportunity: EntryOpportunity = JSON.parse(row.body);
      if (opportunity.instrument.id === instrumentId)
        this.finish(p, opportunity, time, 'unknown', `Missing coherent history: ${reason}`);
    }
  }
  /** One shared candle, at most three policy steps; no providers, outbox, or public learning writes. */
  step(
    cohort: EntryCohort,
    data: Dataset,
    time: number,
    observedAt: number,
    enroll = true,
    timingMode: 'observed' | 'modeled' = 'observed',
    executionBars?: Bar[],
  ) {
    const bar = data.intraday.find((b) => b.end === time);
    if (!bar) return;
    const key = stableId(
      cohort.id,
      data.instrument.id,
      data.daily.at(-1)?.end,
      data.benchmark.at(-1)?.end,
    );
    let detected = this.detection.get(key);
    if (!detected) {
      const attempts: QualificationAttempt[] = [];
      detected = {
        attempts,
        candidates: detect(data, cohort.config, time, (a) => attempts.push(a), 'feasible').sort(
          (a, b) => b.breakout.end - a.breakout.end,
        ),
      };
      if (this.detection.size >= 100) this.detection.clear();
      this.detection.set(key, detected);
    }
    const { attempts, candidates } = detected;
    const all = this.positions(cohort.id);
    if (enroll)
      for (const attempt of attempts.filter((a) => a.at >= cohort.startedAt)) {
        const id = stableId(
          'entry-opportunity-v1',
          cohort.id,
          data.instrument.id,
          attempt.direction,
          attempt.at,
        );
        const eligible = attempt.checks.every(
          (c) => c.passed || c.name === 'Provisional reward/risk',
        );
        const opportunity: EntryOpportunity = {
          id,
          cohortId: cohort.id,
          instrument: data.instrument,
          at: attempt.at,
          observedAt,
          direction: attempt.direction,
          checks: attempt.checks,
          eligible,
        };
        const changed = this.store.db
          .prepare('INSERT OR IGNORE INTO entry_opportunities VALUES(?,?,?,?,?)')
          .run(id, cohort.id, data.instrument.id, attempt.at, JSON.stringify(opportunity)).changes;
        if (changed && eligible)
          for (const policy of entryPolicies) {
            const p: EntryPosition = {
              id: stableId(id, policy),
              opportunityId: id,
              cohortId: cohort.id,
              instrument: data.instrument,
              policy,
              state: 'waiting',
            };
            all.push(p);
            this.save(p);
          }
      }
    for (const p of all) {
      const row = this.store.db
        .prepare('SELECT body FROM entry_opportunities WHERE id=?')
        .get(p.opportunityId) as { body: string };
      const opportunity: EntryOpportunity = JSON.parse(row.body);
      if (opportunity.instrument.id !== data.instrument.id) continue;
      if (!p.idea) {
        const c = candidates.find(
          (c) => c.breakout.end === opportunity.at && c.direction === opportunity.direction,
        );
        const baselinePassed = opportunity.checks.every((c) => c.passed);
        const others = all.filter(
          (other) =>
            other.id !== p.id &&
            other.policy === p.policy &&
            other.state !== 'resolved' &&
            other.idea &&
            !terminalStates.has(other.idea.state),
        );
        if (
          c &&
          (p.policy !== 'baseline' || baselinePassed) &&
          others.length < 20 &&
          !others.some(
            (o) =>
              o.idea!.candidate.instrument.id === data.instrument.id &&
              o.idea!.candidate.direction === c.direction,
          )
        ) {
          const candidate = structuredClone(c);
          candidate.strategyVersion = cohort.version;
          candidate.retest = findRetest(data, candidate, cohort.config, time, p.policy);
          p.idea = {
            candidate,
            state: 'watching',
            lastBar: c.breakout.end,
            milestones: [],
            createdAt: observedAt,
          };
          // Late history is not a new observed opportunity; never advance over an unseen gap.
          if (c.breakout.end < bar.start) {
            this.finish(
              p,
              opportunity,
              time,
              'unknown',
              'Missing prospective candles before candidate enrollment',
            );
            continue;
          }
        } else if (
          sessionsAfter(opportunity.at, time, data.instrument.market, data.sessions) >=
          cohort.config.retestBars + cohort.config.confirmationSessions
        ) {
          this.finish(
            p,
            opportunity,
            time,
            'no_entry',
            baselinePassed
              ? 'No entry before expiry or capacity available'
              : 'Baseline qualification rejected',
          );
          continue;
        }
      }
      if (p.idea) {
        if (p.terminalAt !== undefined) {
          if (p.entry && p.economics)
            for (const executionBar of executionBars ?? [bar])
              stepEconomics(
                p.economics,
                p.entry,
                executionBar,
                p.terminalState === 'time_exit' ? p.terminalAt : undefined,
                p.terminalAt,
              );
          if (p.economics?.cases.every((c) => c.execution && c.execution.status !== 'open'))
            this.finish(p, opportunity, time, p.terminalState!);
          else this.save(p);
          continue;
        }
        if (!p.idea.candidate.retest)
          p.idea.candidate.retest = findRetest(
            data,
            p.idea.candidate,
            cohort.config,
            time,
            p.policy,
          );
        const result = advance(
          p.idea,
          { ...data, intraday: [bar] },
          cohort.config,
          time,
          true,
          p.policy,
        );
        p.idea = result.idea;
        p.state = result.idea.state;
        for (const e of result.events)
          if (e.state === 'entry_triggered') {
            p.entry = e;
            p.economics = beginEconomics(
              e,
              timingMode === 'modeled'
                ? {}
                : {
                    sourceObservedAt: sourceObservedAt(this.store, data.instrument, e.marketTime),
                    detectedAt: observedAt,
                  },
              cohort.assumptions,
            );
          }
        if (p.entry && p.economics)
          for (const executionBar of executionBars ?? [bar])
            stepEconomics(
              p.economics,
              p.entry,
              executionBar,
              p.idea.state === 'time_exit' ? time : undefined,
              terminalStates.has(p.idea.state) ? time : undefined,
            );
        if (terminalStates.has(p.idea.state)) {
          p.signalPerformance = result.events.find((e) => e.state === p.idea!.state)?.performance;
          if (
            p.entry &&
            p.economics &&
            !p.economics.cases.every((c) => c.execution && c.execution.status !== 'open')
          ) {
            p.terminalAt = time;
            p.terminalState = p.idea.state;
            p.state = 'closing';
            this.save(p);
          } else this.finish(p, opportunity, time, p.idea.state);
          continue;
        }
      }
      this.save(p);
    }
  }
  process(now: number, limit = 50) {
    if (
      this.store.settings().paused ||
      this.store.get('budget_paused', false) ||
      this.store.get('learning_paused', false)
    )
      return;
    const active = this.cohort(now);
    const cohorts = (
      this.store.db.prepare('SELECT body FROM entry_cohorts ORDER BY started_at').all() as {
        body: string;
      }[]
    )
      .map((r) => JSON.parse(r.body) as EntryCohort)
      .filter((c) => c.id === active.id || this.positions(c.id).length);
    let steps = 0;
    const work: { id: string; cohort: EntryCohort; value: Work; data: Dataset }[] = [];
    for (const cohort of cohorts) {
      const instruments = new Map<string, Instrument>();
      if (cohort.id === active.id)
        for (const i of this.store.baseMonitored()) instruments.set(i.id, i);
      for (const p of this.positions(cohort.id)) instruments.set(p.instrument.id, p.instrument);
      for (const instrument of instruments.values()) {
        const id = stableId(cohort.id, instrument.id),
          cutoff = now - (instrument.market === 'equity' ? 16 * 60_000 : 0);
        const data = dataset(this.store, instrument, cutoff);
        const row = this.store.db
          .prepare('SELECT body FROM entry_research_work WHERE id=?')
          .get(id) as { body: string } | undefined;
        const value: Work = row
          ? JSON.parse(row.body)
          : {
              instrument,
              through: Math.max(cohort.startedAt, data.intraday.at(-1)?.end ?? cohort.startedAt),
              revision: this.store.get(`learning_history_revision:${instrument.id}`, 0),
              benchmarkRevision: this.store.get(
                `learning_history_revision:${benchmarkFor(instrument).id}`,
                0,
              ),
            };
        if (now - (data.intraday.at(-1)?.end ?? 0) > 35 * DAY) {
          this.unavailable(
            cohort.id,
            instrument.id,
            now,
            'Source coverage outside automatic retention',
          );
          value.missing = 'Required source coverage outside automatic retention';
        }
        work.push({ id, cohort, value, data });
      }
    }
    while (steps + 3 <= Math.min(50, limit)) {
      const ready = work
        .map((w) => ({ ...w, next: w.data.intraday.find((b) => b.end > w.value.through) }))
        .filter((w) => w.next)
        .sort((a, b) => a.next!.end - b.next!.end || a.id.localeCompare(b.id));
      const next = ready[0];
      if (!next) break;
      const { id, cohort, value, data } = next,
        bar = next.next!;
      try {
        if (
          this.store.get(`history_changed:${data.instrument.id}`, false) ||
          this.store.get(`history_changed:${benchmarkFor(data.instrument).id}`, false) ||
          value.revision !== this.store.get(`learning_history_revision:${data.instrument.id}`, 0) ||
          (value.benchmarkRevision ?? 0) !==
            this.store.get(`learning_history_revision:${benchmarkFor(data.instrument).id}`, 0)
        )
          throw new Error('Missing unchanged source history after revision');
        const snapshot = {
          ...data,
          daily: data.daily.filter((b) => b.end <= bar.end),
          benchmark: data.benchmark.filter((b) => b.end <= bar.end),
          intraday: data.intraday.filter((b) => b.end <= bar.end),
        };
        checkIntraday(snapshot, value.through, bar.end);
        snapshot.weekly = weeklyBars(
          snapshot.daily,
          data.instrument.market,
          data.sessions,
          bar.end,
        );
        checkDaily(data.instrument, snapshot.daily, data.sessions, bar.end);
        checkDaily(benchmarkFor(data.instrument), snapshot.benchmark, data.sessions, bar.end);
        this.store.transaction(() =>
          this.step(
            cohort,
            snapshot,
            bar.end,
            sourceObservedAt(this.store, data.instrument, bar.end) ?? now,
            cohort.id === active.id,
          ),
        );
        value.missing = undefined;
        value.through = bar.end;
      } catch (error) {
        value.missing =
          error instanceof Error ? error.message : 'ENTRY_RESEARCH_HISTORY_UNAVAILABLE';
        // Stop this instrument for this invocation. Missing history never becomes zero exposure.
        next.data.intraday.length = 0;
        this.unavailable(cohort.id, data.instrument.id, bar.end, value.missing);
        value.through = bar.end;
        value.revision = this.store.get(`learning_history_revision:${data.instrument.id}`, 0);
        value.benchmarkRevision = this.store.get(
          `learning_history_revision:${benchmarkFor(data.instrument).id}`,
          0,
        );
      }
      this.store.db
        .prepare(
          'INSERT INTO entry_research_work VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
        )
        .run(id, JSON.stringify(value));
      steps += 3;
    }
    for (const w of work)
      this.store.db
        .prepare('INSERT OR IGNORE INTO entry_research_work VALUES(?,?)')
        .run(w.id, JSON.stringify(w.value));
    this.store.set('entry_research_progress', {
      at: now,
      steps,
      backlog: work.reduce(
        (n, w) => n + w.data.intraday.filter((b) => b.end > w.value.through).length * 3,
        0,
      ),
    });
    if (now - this.store.get('entry_source_pruned', 0) > DAY) {
      this.store.db
        .prepare('DELETE FROM source_observations WHERE observed_at<?')
        .run(now - 120 * DAY);
      this.store.set('entry_source_pruned', now);
    }
  }
  summary(now = Date.now()) {
    const id = this.store.get<string | null>('entry_research_cohort', null),
      cohort = id ? this.getCohort(id) : undefined;
    const counts = id
      ? this.store.db
          .prepare(
            'SELECT policy,COUNT(*) AS n FROM entry_results WHERE cohort_id=? GROUP BY policy',
          )
          .all(id)
      : [];
    const work = (
      this.store.db.prepare('SELECT body FROM entry_research_work').all() as { body: string }[]
    ).map((r) => JSON.parse(r.body) as Work);
    return {
      mode: 'shadow-only',
      cohort,
      results: counts,
      progress: this.store.get('entry_research_progress', null),
      errors: work
        .filter((w) => w.missing)
        .map((w) => ({ symbol: w.instrument.symbol, reason: w.missing })),
      paused: this.store.get('learning_paused', false) || this.store.get('budget_paused', false),
      checkedAt: now,
      activation: 'Entry policies cannot be promoted through /learning promote.',
    };
  }
}
