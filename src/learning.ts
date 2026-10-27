import { calloutOutcome as outcome } from './callout-outcomes.js';
import type { SignalEvent, LearningFeatures } from './domain.js';
import type { Store } from './sql-store.js';
import { stableId, strategyVersion } from './core/strategy.js';
import { currentReversal, reversalDefaults, saveReversal } from './reversal-config.js';
import { DailyRecap } from './daily-recap.js';
import { ShadowLearning, type ShadowScore } from './shadow-learning.js';
import { LearningEvaluations, learningContext, recurringFailure } from './learning-evaluation.js';
import { LearningObservations, sampleId } from './learning-observations.js';
import {
  LearningDiagnostics,
  diagnosticText,
  type OutcomeDiagnostics,
} from './learning-diagnostics.js';
const DAY = 86_400_000;
export type Family = 'reversal_warning' | 'strategy_setup' | 'strategy_entry';
type Outcome = 'failure' | 'success' | 'unconfirmed' | 'ambiguous' | 'unknown';
interface Counts {
  failure: number;
  success: number;
  unconfirmed: number;
  ambiguous: number;
  unknown: number;
}
const zero = (): Counts => ({ failure: 0, success: 0, unconfirmed: 0, ambiguous: 0, unknown: 0 });
interface Pending {
  event: SignalEvent;
  family: Family;
  features: LearningFeatures;
  experiments: { id: string; pass: boolean }[];
  shadow?: ShadowScore;
}
interface Group {
  family: Family;
  market: string;
  direction: string;
  timeframe: string;
  version: string;
  context: string;
  counts: Counts;
  filters: Record<string, { pass: Counts; blocked: Counts }>;
}
export interface Experiment {
  id: string;
  family: Family;
  filter: 'benchmark' | 'volume025' | 'volume050';
  version: string;
  proposedAt: number;
  status: 'shadow' | 'promoted' | 'rolled_back' | 'superseded' | 'rejected';
  pass: Counts;
  blocked: Counts;
  evidence: { eligible: number; failures: number; difference: number };
  promotedVersion?: string;
  previousVersion?: string;
  evaluationId?: string;
}
interface LearningCase {
  id: string;
  family: Family;
  outcome: Outcome;
  resolved: number;
  callout: SignalEvent;
  terminal: SignalEvent;
  features: LearningFeatures;
  review: string;
  diagnostics?: OutcomeDiagnostics | { coverage: 'unavailable' };
}
function eligible(e: SignalEvent): boolean {
  return (
    !e.debug &&
    !!e.learning &&
    e.learning.at <= e.marketTime &&
    (e.strategyVersion.startsWith('br-v1-') || e.tracker?.type === 'reversal')
  );
}
function passFilter(features: LearningFeatures, filter: Experiment['filter']): boolean | undefined {
  if (filter === 'benchmark')
    return features.benchmarkTrend === 'unknown' ? undefined : features.benchmarkAgreement;
  if (features.breakoutRelativeVolume === undefined || features.breakoutThreshold === undefined)
    return;
  return (
    features.breakoutRelativeVolume >=
    features.breakoutThreshold + (filter === 'volume025' ? 0.25 : 0.5)
  );
}
function filters(family: Family): Experiment['filter'][] {
  return family === 'reversal_warning'
    ? ['benchmark']
    : family === 'strategy_entry'
      ? ['volume025', 'volume050']
      : [];
}
const total = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
const decisive = (c: Counts) => c.failure + c.success;
function reviewText(p: Pending, e: SignalEvent): string {
  const f = p.features;
  const observed =
    e.tracker?.type === 'reversal'
      ? `The expected reversal was cancelled at a completed close of ${e.tracker.close}; the warning's cancellation level was ${e.tracker.cancellationLevel}.`
      : e.state === 'invalidated'
        ? `Price crossed the frozen invalidation level ${e.candidate.level}.`
        : 'The holding window ended with an unfavorable directional move.';
  const movement =
    e.performance?.changePercent ??
    (e.tracker?.type === 'reversal' ? e.tracker.directionalChangePercent : undefined) ??
    (f.close !== undefined && f.close > 0 && e.learning?.close !== undefined
      ? (((e.direction === 'bullish' ? 1 : -1) * (e.learning.close - f.close)) / f.close) * 100
      : undefined);
  return `**Callout was wrong · ${p.family.replaceAll('_', ' ')}**\nObserved failure: ${observed}\nOriginal context: benchmark ${f.benchmarkTrend}; breakout relative volume ${f.breakoutRelativeVolume?.toFixed(2) ?? 'unknown'}×; daily relative volume ${f.dailyRelativeVolume?.toFixed(2) ?? 'unknown'}×; 15-minute relative volume ${f.intradayRelativeVolume?.toFixed(2) ?? 'unknown'}×; candle-direction pressure ${f.pressure ?? 'unknown'} (estimate, not measured buyer/seller volume); relative strength ${f.relativeStrength?.toFixed(4) ?? 'unknown'}; ATR ${f.atr?.toFixed(4) ?? 'unknown'}.\nReference-price movement: ${movement === undefined ? 'unknown' : `${movement >= 0 ? '+' : ''}${movement.toFixed(2)}%`}; not fills or realized profit.\nHypothesis to test: ${f.benchmarkTrend !== 'unknown' && !f.benchmarkAgreement ? 'opposing benchmark movement may accompany failures.' : f.breakoutRelativeVolume !== undefined ? 'stronger breakout volume may filter some failures.' : 'compare benchmark alignment across future warnings.'}\nAssociation, not a proven market cause. Rule version: ${p.event.strategyVersion}.`;
}
export class Learning {
  constructor(readonly store: Store) {}
  private rows<T>(
    table: 'learning_cases' | 'learning_counts' | 'learning_experiments' | 'learning_pending',
  ): T[] {
    return (this.store.db.prepare(`SELECT body FROM ${table}`).all() as { body: string }[]).map(
      (r) => JSON.parse(r.body),
    );
  }
  experiments(): Experiment[] {
    return this.rows<Experiment>('learning_experiments');
  }
  cases(): LearningCase[] {
    return (
      this.store.db
        .prepare('SELECT body FROM learning_cases ORDER BY resolved DESC LIMIT 20')
        .all() as { body: string }[]
    ).map((r) => {
      const record: LearningCase = JSON.parse(r.body);
      return {
        ...record,
        diagnostics: new LearningDiagnostics(this.store).get(
          sampleId(record.callout, record.family),
        ) ?? { coverage: 'unavailable' as const },
      };
    });
  }
  private putExperiment(e: Experiment) {
    this.store.db
      .prepare(
        'INSERT INTO learning_experiments VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(e.id, JSON.stringify(e));
  }
  status(now = Date.now()) {
    return {
      shadowModel: {
        mode: 'shadow-only',
        lastTrainingDay: this.store.get('shadow_learning_day', null),
        report: new ShadowLearning(this.store).report(),
        scorecards: new LearningEvaluations(this.store).summary().filter((s) => s.kind === 'model'),
      },
      paused: this.store.get('learning_paused', false),
      error: this.store.get('learning_error', null),
      outcomeDiagnostics: new LearningDiagnostics(this.store).report(),
      backlog: Number(
        (
          this.store.db
            .prepare('SELECT count(*) AS n FROM events WHERE seq>?')
            .get(this.store.get('learning_cursor', 0)) as { n: number }
        ).n,
      ),
      pending: Number(
        (this.store.db.prepare('SELECT count(*) AS n FROM learning_pending').get() as { n: number })
          .n,
      ),
      experiments: this.experiments().map((e) => ({
        id: e.id,
        status: e.status,
        reviewReady: this.ready(e, now),
        resolved: total(e.pass) + total(e.blocked),
        scorecard: e.evaluationId
          ? new LearningEvaluations(this.store).inspect(e.evaluationId)
          : null,
      })),
    };
  }
  ready(e: Experiment, now: number): boolean {
    if (!e.evaluationId) return false;
    const evaluations = new LearningEvaluations(this.store);
    const evaluation = evaluations.get(e.evaluationId);
    return (
      e.status === 'shadow' &&
      evaluation?.sourceId === e.id &&
      evaluation.family === e.family &&
      evaluation.version === e.version &&
      evaluation.kind === 'filter' &&
      evaluation.definition.filter === e.filter &&
      !!evaluations.inspect(e.evaluationId)?.reviewReady &&
      evaluation.endsAt <= now
    );
  }
  scorecard(e: Experiment) {
    return e.evaluationId ? new LearningEvaluations(this.store).inspect(e.evaluationId) : null;
  }
  private capture(e: SignalEvent, family: Family, observedAt: number) {
    if (
      this.store.db
        .prepare('SELECT 1 FROM learning_pending WHERE id=?')
        .get(`${e.ideaId}:${family}`)
    ) {
      new LearningObservations(this.store).progress(e, family);
      return;
    }
    const p: Pending = {
      event: e,
      family,
      features: e.learning!,
      experiments: [],
      shadow: new ShadowLearning(this.store).score(e, family),
    };
    for (const experiment of this.experiments().filter(
      (x) =>
        x.status === 'shadow' &&
        x.family === family &&
        x.version === e.strategyVersion &&
        e.marketTime > x.proposedAt,
    )) {
      const pass = passFilter(p.features, experiment.filter);
      if (
        pass !== undefined &&
        (!experiment.evaluationId ||
          new LearningEvaluations(this.store).assign(
            experiment.evaluationId,
            e,
            pass,
            undefined,
            undefined,
            observedAt,
          ))
      )
        p.experiments.push({ id: experiment.id, pass });
    }
    new LearningObservations(this.store).start(e, family, e.recordedAt);
    if (
      p.shadow?.evaluationId &&
      !new LearningEvaluations(this.store).assign(
        p.shadow.evaluationId,
        e,
        p.shadow.retain,
        p.shadow.score,
        p.shadow.baseline,
        observedAt,
      )
    )
      p.shadow = undefined;
    this.store.db
      .prepare('INSERT OR IGNORE INTO learning_pending VALUES(?,?)')
      .run(`${e.ideaId}:${family}`, JSON.stringify(p));
  }
  private resolve(
    p: Pending,
    e: SignalEvent,
    result: Outcome,
    publish: boolean,
    observedAt: number,
  ) {
    new LearningObservations(this.store).terminal(p.event, p.family, e);
    new LearningObservations(this.store).process(observedAt, 1, sampleId(p.event, p.family));
    new ShadowLearning(this.store).record({
      id: stableId('learning-sample', p.event.id, p.family),
      family: p.family,
      callout: p.event,
      terminal: e,
      features: p.features,
      outcome: result,
      resolved: e.marketTime,
      observedAt,
      shadow: p.shadow,
    });
    new DailyRecap(this.store).record(p.event, e, {
      family: p.family,
      outcome: result,
      experiments: p.experiments,
      shadow: p.shadow,
    });
    const context = learningContext(p.event);
    const timeframe = p.event.tracker?.timeframe ?? (p.family === 'strategy_setup' ? '1d' : '15m');
    const key = JSON.stringify([
      p.family,
      e.instrument.market,
      e.direction,
      timeframe,
      p.event.strategyVersion,
      context,
    ]);
    const old = this.store.db.prepare('SELECT body FROM learning_counts WHERE key=?').get(key) as
      { body: string } | undefined;
    const group: Group = old
      ? JSON.parse(old.body)
      : {
          family: p.family,
          market: e.instrument.market,
          direction: e.direction,
          timeframe,
          version: p.event.strategyVersion,
          context,
          counts: zero(),
          filters: {},
        };
    group.counts[result]++;
    for (const filter of filters(p.family)) {
      const pass = passFilter(p.features, filter);
      if (pass === undefined) continue;
      const partition = group.filters[filter] ?? { pass: zero(), blocked: zero() };
      partition[pass ? 'pass' : 'blocked'][result]++;
      group.filters[filter] = partition;
    }
    this.store.db
      .prepare(
        'INSERT INTO learning_counts VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body',
      )
      .run(key, JSON.stringify(group));
    for (const assignment of p.experiments) {
      const experiment = this.experiments().find((x) => x.id === assignment.id);
      if (experiment && ['shadow', 'superseded'].includes(experiment.status)) {
        experiment[assignment.pass ? 'pass' : 'blocked'][result]++;
        this.putExperiment(experiment);
      }
    }
    const exceptional =
      p.family === 'strategy_entry' &&
      result === 'success' &&
      (e.state === 'final_target' || (e.performance?.changePercent ?? 0) >= 10);
    if (result === 'failure' || exceptional) {
      const id = stableId('learning-case', p.event.id, e.id),
        review =
          result === 'failure'
            ? `${reviewText(p, e)}\n${diagnosticText(new LearningDiagnostics(this.store).get(sampleId(p.event, p.family)))}`
            : 'Exceptional successful entry; reference-price outcome, not realized profit.';
      const record: LearningCase = {
        id,
        family: p.family,
        outcome: result,
        resolved: e.marketTime,
        callout: p.event,
        terminal: e,
        features: p.features,
        review,
      };
      this.store.db
        .prepare('INSERT OR IGNORE INTO learning_cases VALUES(?,?,?)')
        .run(id, e.marketTime, JSON.stringify(record));
      if (result === 'failure' && publish && !e.recovery && this.store.hasIdeaPublication(e.ideaId))
        this.store.enqueue(
          {
            ...e,
            kind: 'learning_review',
            id: stableId('failure-review', id),
            sourceEventId: e.id,
            learningText: review,
          },
          'updates',
        );
    }
    this.store.db.prepare('DELETE FROM learning_pending WHERE id=?').run(`${e.ideaId}:${p.family}`);
    this.store.set('learning_resolved', this.store.get('learning_resolved', 0) + 1);
  }
  process(now: number, limit = 20) {
    new DailyRecap(this.store).initialize(now);
    if (
      this.store.get('budget_paused', false) ||
      this.store.settings().paused ||
      this.store.get('learning_paused', false)
    )
      return;
    const rows = this.store.db
      .prepare('SELECT seq,body FROM events WHERE seq>? ORDER BY seq LIMIT ?')
      .all(this.store.get('learning_cursor', 0), limit) as { seq: number; body: string }[];
    for (const row of rows)
      this.store.transaction(() => {
        const e: SignalEvent = JSON.parse(row.body);
        if (eligible(e) && !e.kind?.startsWith('learning_')) {
          const reversal = e.tracker?.type === 'reversal';
          const family: Family = reversal
            ? 'reversal_warning'
            : e.candidate.entry === undefined
              ? 'strategy_setup'
              : 'strategy_entry';
          if (
            (reversal && e.tracker?.type === 'reversal' && e.tracker.phase === 'warning') ||
            (!reversal && ['watching', 'setup_ready'].includes(e.state))
          )
            this.capture(e, family, now);
          // Entry resolves the pre-entry setup, then begins an independent entry outcome.
          const families: Family[] =
            !reversal && e.state === 'entry_triggered' ? ['strategy_setup'] : [family];
          for (const f of families) {
            const pending = this.store.db
              .prepare('SELECT body FROM learning_pending WHERE id=?')
              .get(`${e.ideaId}:${f}`) as { body: string } | undefined;
            const result = outcome(e);
            if (pending && result)
              this.resolve(
                JSON.parse(pending.body),
                e,
                result,
                !e.recovery && now - e.marketTime < DAY,
                now,
              );
          }
          if (!reversal && e.state === 'entry_triggered') this.capture(e, 'strategy_entry', now);
        }
        this.store.set('learning_cursor', row.seq);
      });
    this.store.db.prepare('DELETE FROM learning_cases WHERE resolved<?').run(now - 90 * DAY);
    this.store.db.exec(
      'DELETE FROM learning_cases WHERE id IN (SELECT id FROM learning_cases ORDER BY resolved DESC,id DESC LIMIT -1 OFFSET 1000)',
    );
    // Only propose/report after the bounded backfill has caught up.
    if (
      !this.store.db
        .prepare('SELECT 1 FROM events WHERE seq>? LIMIT 1')
        .get(this.store.get('learning_cursor', 0))
    ) {
      // A discontinuous history rebuild can discard a warning without an observable outcome.
      // Resolve that learning sample as unknown rather than inventing a failure or retaining it forever.
      for (const pending of this.rows<Pending>('learning_pending')
        .filter((p) => p.family === 'reversal_warning')
        .slice(0, 20)) {
        const cursor = this.store.get<{ lastBar: number; pending?: { id: string } } | null>(
          `tracker:v1:${pending.event.instrument.id}:${pending.event.tracker!.timeframe}`,
          null,
        );
        if (
          cursor &&
          ((cursor.lastBar > pending.event.marketTime &&
            cursor.pending?.id !== pending.event.ideaId) ||
            !this.store.monitored().some((i) => i.id === pending.event.instrument.id))
        )
          this.store.transaction(() =>
            this.resolve(
              pending,
              { ...pending.event, marketTime: cursor.lastBar },
              'unknown',
              false,
              now,
            ),
          );
      }
      this.store.transaction(() => this.propose(now));
      new LearningObservations(this.store).process(now);
      new LearningEvaluations(this.store).process(now);
      new ShadowLearning(this.store).daily(now);
      this.weekly(now);
      new DailyRecap(this.store).queue(now);
    }
  }
  private propose(now: number) {
    for (const experiment of this.experiments()) {
      const active =
        experiment.family === 'reversal_warning'
          ? currentReversal(this.store).version
          : strategyVersion(this.store.strategy());
      if (experiment.status === 'shadow' && experiment.version !== active) {
        experiment.status = 'superseded';
        this.putExperiment(experiment);
        new DailyRecap(this.store).activity(experiment, 'superseded by a rule-version change', now);
      } else if (experiment.status === 'shadow' && !experiment.evaluationId) {
        experiment.evaluationId = new LearningEvaluations(this.store).create(
          experiment.id,
          experiment.family,
          experiment.version,
          'filter',
          { filter: experiment.filter, legacyRestart: true },
          now,
        ).id;
        this.putExperiment(experiment);
      } else if (experiment.status === 'shadow' && experiment.evaluationId) {
        const result = new LearningEvaluations(this.store).inspect(experiment.evaluationId);
        if (result?.finalized && !result.reviewReady) {
          experiment.status = 'rejected';
          this.putExperiment(experiment);
          new DailyRecap(this.store).activity(
            experiment,
            'shadow evaluation failed its frozen evidence requirements',
            now,
          );
        }
      }
    }
    const groups = this.rows<Group>('learning_counts');
    const pools = new Map<
      string,
      {
        family: Family;
        version: string;
        filter: Experiment['filter'];
        pass: Counts;
        blocked: Counts;
      }
    >();
    for (const g of groups)
      for (const filter of filters(g.family)) {
        const partition = g.filters[filter];
        if (!partition) continue;
        const key = JSON.stringify([g.family, g.version, filter]);
        const pool = pools.get(key) ?? {
          family: g.family,
          version: g.version,
          filter,
          pass: zero(),
          blocked: zero(),
        };
        for (const o of Object.keys(zero()) as Outcome[]) {
          pool.pass[o] += partition.pass[o];
          pool.blocked[o] += partition.blocked[o];
        }
        pools.set(key, pool);
      }
    for (const [key, pool] of [...pools].sort(([a], [b]) => a.localeCompare(b))) {
      if (this.experiments().filter((e) => e.status === 'shadow').length >= 2) break;
      const active =
        pool.family === 'reversal_warning'
          ? currentReversal(this.store).version
          : strategyVersion(this.store.strategy());
      if (active !== pool.version) continue;
      if (
        pool.filter !== 'benchmark' &&
        this.store.strategy().breakoutVolume + (pool.filter === 'volume025' ? 0.25 : 0.5) > 5
      )
        continue;
      const previous = this.experiments()
        .filter(
          (e) => e.family === pool.family && e.version === pool.version && e.filter === pool.filter,
        )
        .sort((a, b) => b.proposedAt - a.proposedAt)[0];
      if (previous && previous.status !== 'rejected') continue;
      if (previous) {
        const after = new LearningEvaluations(this.store).get(previous.evaluationId!)!.endsAt;
        pool.pass = zero();
        pool.blocked = zero();
        const fresh = this.store.db
          .prepare(
            'SELECT body FROM learning_journal WHERE family=? AND version=? AND resolved>? ORDER BY resolved DESC,id DESC LIMIT 600',
          )
          .all(pool.family, pool.version, after) as { body: string }[];
        for (const row of fresh) {
          const sample: import('./shadow-learning.js').OutcomeSample = JSON.parse(row.body);
          if (
            sample.callout.marketTime <= after ||
            sample.observedAt > now ||
            sample.resolved > now ||
            sample.callout.recovery ||
            sample.terminal.recovery ||
            sample.callout.debug
          )
            continue;
          const pass = passFilter(sample.features, pool.filter);
          if (pass !== undefined) pool[pass ? 'pass' : 'blocked'][sample.outcome]++;
        }
      }
      const eligible = decisive(pool.pass) + decisive(pool.blocked),
        failures = pool.pass.failure + pool.blocked.failure;
      const difference =
        pool.blocked.failure / decisive(pool.blocked) - pool.pass.failure / decisive(pool.pass);
      const id = previous
        ? stableId('learning-experiment', key, String(now))
        : stableId('learning-experiment', key);
      const recurring = recurringFailure(this.store, pool.family, pool.version, now);
      if (
        eligible < (recurring ? 10 : 20) ||
        failures < 5 ||
        decisive(pool.pass) < (recurring ? 3 : 5) ||
        decisive(pool.blocked) < (recurring ? 3 : 5) ||
        !(difference >= 0.15) ||
        this.experiments().some((e) => e.id === id)
      )
        continue;
      this.putExperiment({
        id,
        ...pool,
        pass: zero(),
        blocked: zero(),
        proposedAt: now,
        status: 'shadow',
        evidence: { eligible, failures, difference },
        evaluationId: new LearningEvaluations(this.store).create(
          id,
          pool.family,
          pool.version,
          'filter',
          { filter: pool.filter, sourceThreshold: this.store.strategy().breakoutVolume },
          now,
          recurring ? 'recurring_failure' : 'normal',
        ).id,
      });
      new DailyRecap(this.store).activity(
        this.experiments().find((e) => e.id === id)!,
        'started shadow testing a possible improvement',
        now,
      );
    }
  }
  report(): string {
    const groups = this.rows<Group>('learning_counts');
    if (!groups.length)
      return `No resolved learning outcomes yet.\n${new ShadowLearning(this.store).report()}\n${new LearningEvaluations(this.store).report()}\n${new LearningDiagnostics(this.store).report()}`;
    return [
      'Learning report · associations, not proven causes. Reference-price outcomes, not realized profit.',
      new ShadowLearning(this.store).report(),
      new LearningEvaluations(this.store).report(),
      new LearningDiagnostics(this.store).report(),
      ...groups.map((g) => {
        const n = decisive(g.counts);
        return `${g.family} · ${g.market} · ${g.direction} · ${g.timeframe} · ${g.version} · ${g.context}\n${total(g.counts)} observations; ${g.counts.failure}/${n} decisive outcomes failed (${n ? ((100 * g.counts.failure) / n).toFixed(1) : 'unknown'}%); successes ${g.counts.success}; unconfirmed ${g.counts.unconfirmed}; ambiguous ${g.counts.ambiguous}; unknown ${g.counts.unknown}. ${n < 10 ? 'Insufficient evidence (fewer than 10).' : ''}`;
      }),
    ].join('\n\n');
  }
  private weekly(now: number) {
    const monday = now - ((new Date(now).getUTCDay() + 6) % 7) * DAY;
    const week = new Date(monday).toISOString().slice(0, 10);
    if (!this.store.get('learning_week', null)) {
      this.store.set('learning_week', week);
      return;
    }
    if (this.store.get('learning_week', '') === week) return;
    const resolved = this.store.get('learning_resolved', 0);
    if (resolved > this.store.get('learning_reported', 0)) {
      const row = this.store.db
        .prepare('SELECT body FROM events ORDER BY seq DESC LIMIT 1')
        .get() as { body: string } | undefined;
      if (row) {
        const e: SignalEvent = JSON.parse(row.body);
        this.store.enqueue(
          {
            ...e,
            id: stableId('learning-week', week),
            ideaId: 'learning-report',
            tracker: undefined,
            kind: 'learning_report',
            strategyVersion: 'system',
            marketTime: now,
            recordedAt: now,
            learningText: this.report(),
          },
          'summaries',
        );
      }
    }
    this.store.set('learning_week', week);
    this.store.set('learning_reported', resolved);
  }
  promote(id: string, now: number): string {
    const e = this.experiments().find((x) => x.id === id);
    if (!e || !this.ready(e, now))
      throw new Error(
        `EXPERIMENT_NOT_REVIEW_READY: ${e ? (this.scorecard(e)?.blockers.join(', ') ?? 'FRESH_EVALUATION_REQUIRED') : 'UNKNOWN_EXPERIMENT'}`,
      );
    let version: string;
    this.store.transaction(() => {
      if (e.filter === 'benchmark') {
        const current = currentReversal(this.store);
        if (current.version !== e.version) throw new Error('EXPERIMENT_SOURCE_VERSION_CHANGED');
        e.previousVersion = current.version;
        saveReversal(this.store, current.config);
        version = saveReversal(this.store, { ...current.config, benchmarkAgreement: true });
      } else {
        const config = this.store.strategy();
        if (strategyVersion(config) !== e.version)
          throw new Error('EXPERIMENT_SOURCE_VERSION_CHANGED');
        e.previousVersion = e.version;
        this.store.saveStrategy({
          ...config,
          breakoutVolume: config.breakoutVolume + (e.filter === 'volume025' ? 0.25 : 0.5),
        });
        version = strategyVersion(this.store.strategy());
      }
      e.promotedVersion = version!;
      e.status = 'promoted';
      this.putExperiment(e);
      new DailyRecap(this.store).activity(
        e,
        'manager-approved promotion; production validation still required',
        now,
      );
    });
    return e.promotedVersion!;
  }
  rollback(id: string, now = Date.now()): string {
    const e = this.experiments().find((x) => x.id === id);
    if (!e || e.status !== 'promoted' || !e.previousVersion)
      throw new Error('NO_PROMOTED_EXPERIMENT');
    this.store.transaction(() => {
      if (e.filter === 'benchmark') {
        if (currentReversal(this.store).version !== e.promotedVersion)
          throw new Error('ACTIVE_VERSION_CHANGED');
        const row = this.store.db
          .prepare('SELECT body FROM reversal_versions WHERE version=?')
          .get(e.previousVersion!) as { body: string } | undefined;
        saveReversal(this.store, row ? JSON.parse(row.body) : reversalDefaults);
      } else {
        if (strategyVersion(this.store.strategy()) !== e.promotedVersion)
          throw new Error('ACTIVE_VERSION_CHANGED');
        this.store.saveStrategy(this.store.version(e.previousVersion!));
      }
      e.status = 'rolled_back';
      this.putExperiment(e);
      new DailyRecap(this.store).activity(
        { ...e, promotedVersion: e.previousVersion },
        'manager-approved rollback',
        now,
      );
    });
    return e.previousVersion;
  }
}
