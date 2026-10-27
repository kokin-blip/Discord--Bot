import type { LearningFeatures, SignalEvent } from './domain.js';
import type { DailyOutcome } from './daily-recap.js';
import type { Family } from './learning.js';
import type { Store } from './sql-store.js';
import { stableId, strategyVersion } from './core/strategy.js';
import { currentReversal } from './reversal-config.js';
import { LearningEvaluations } from './learning-evaluation.js';

const DAY = 86_400_000;
const dayOf = (time: number) => new Date(time - 7 * 3_600_000).toISOString().slice(0, 10);
const schema = 'logistic-v1';
export interface ShadowScore {
  modelId: string;
  score: number;
  retain: boolean;
  baseline?: number;
  evaluationId?: string;
}
export interface OutcomeSample {
  id: string;
  family: Family;
  callout: SignalEvent;
  terminal: SignalEvent;
  features: LearningFeatures;
  outcome: DailyOutcome;
  resolved: number;
  observedAt: number;
  shadow?: ShadowScore;
}
interface Model {
  id: string;
  key: string;
  trainedAt: number;
  cutoff: number;
  weights: number[];
  trainCount: number;
  baseline?: number;
  evaluationId?: string;
  validation: {
    count: number;
    brier: number;
    baselineBrier: number;
    avoidedFailures: number;
    excludedSuccesses: number;
    retained: number;
  };
}
const keyOf = (e: SignalEvent, family: Family) =>
  JSON.stringify([
    family,
    e.instrument.market,
    e.tracker?.timeframe ?? (family === 'strategy_setup' ? '1d' : '15m'),
    e.strategyVersion,
  ]);
const finite = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n);
// Fixed bounded transforms and explicit missing flags avoid fitting preprocessing on future data.
function vector(e: SignalEvent, f: LearningFeatures): number[] {
  const x = [
    1,
    e.direction === 'bullish' ? 1 : -1,
    f.benchmarkTrend === 'unknown' ? 0 : f.benchmarkAgreement ? 1 : -1,
    f.benchmarkTrend === 'unknown' ? 1 : 0,
  ];
  const price = f.close;
  const values = [
    [f.breakoutRelativeVolume, 5],
    [f.dailyRelativeVolume, 5],
    [f.intradayRelativeVolume, 5],
    [f.relativeStrength, 0.1],
    [finite(f.atr) && finite(price) && price > 0 ? f.atr / price : undefined, 0.1],
    [f.rewardRisk, 5],
  ] as const;
  for (const [value, scale] of values)
    x.push(finite(value) ? Math.max(-1, Math.min(1, value / scale)) : 0, finite(value) ? 0 : 1);
  return x;
}
const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
function predict(weights: number[], x: number[]) {
  return sigmoid(weights.reduce((sum, w, i) => sum + w * x[i]!, 0));
}
function fit(samples: OutcomeSample[]): number[] {
  const inputs = samples.map((s) => vector(s.callout, s.features));
  const weights = Array<number>(inputs[0]!.length).fill(0);
  for (let epoch = 0; epoch < 60; epoch++) {
    const gradient = weights.map(() => 0);
    for (let n = 0; n < samples.length; n++) {
      const error = predict(weights, inputs[n]!) - Number(samples[n]!.outcome === 'success');
      for (let j = 0; j < weights.length; j++) gradient[j]! += error * inputs[n]![j]!;
    }
    for (let j = 0; j < weights.length; j++)
      weights[j]! -= 0.3 * (gradient[j]! / samples.length + (j ? 0.01 * weights[j]! : 0));
  }
  return weights;
}
const families: Family[] = ['strategy_setup', 'strategy_entry', 'reversal_warning'];
export class ShadowLearning {
  constructor(readonly store: Store) {}
  score(e: SignalEvent, family: Family): ShadowScore | undefined {
    if (e.debug || e.recovery || !e.learning) return;
    const model = this.store.get<Model | null>(`shadow_model:${keyOf(e, family)}`, null);
    // Backfilled calls never receive a prediction made using later information.
    if (!model || model.trainedAt >= e.marketTime || model.trainedAt > e.recordedAt) return;
    const score = predict(model.weights, vector(e, e.learning));
    const evaluation = model.evaluationId
      ? new LearningEvaluations(this.store).get(model.evaluationId)
      : undefined;
    if (evaluation && e.marketTime >= evaluation.endsAt) return;
    return {
      modelId: model.id,
      score,
      retain: score >= 0.5,
      baseline: model.baseline,
      evaluationId: model.evaluationId,
    };
  }
  record(sample: OutcomeSample) {
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO learning_journal(id,family,version,resolved,observed_at,body) VALUES(?,?,?,?,?,?)',
      )
      .run(
        sample.id,
        sample.family,
        sample.callout.strategyVersion,
        sample.resolved,
        sample.observedAt,
        JSON.stringify(sample),
      );
  }
  daily(now: number) {
    const day = dayOf(now);
    if (this.store.get('shadow_learning_day', '') === day) return;
    const cutoff = Date.parse(`${day}T00:00:00-07:00`);
    const reportDay = dayOf(cutoff - 1);
    this.store.transaction(() => {
      const reports: string[] = [];
      for (const family of families) {
        const version =
          family === 'reversal_warning'
            ? currentReversal(this.store).version
            : strategyVersion(this.store.strategy());
        const rows = this.store.db
          .prepare(
            'SELECT body FROM learning_journal WHERE family=? AND version=? AND resolved<? ORDER BY resolved DESC,id DESC LIMIT 600',
          )
          .all(family, version, cutoff) as { body: string }[];
        const pools = new Map<string, OutcomeSample[]>();
        for (const row of rows) {
          const sample: OutcomeSample = JSON.parse(row.body);
          if (
            sample.observedAt >= cutoff ||
            sample.callout.recovery ||
            sample.terminal.recovery ||
            sample.callout.debug ||
            sample.terminal.debug ||
            !['success', 'failure'].includes(sample.outcome) ||
            sample.resolved < sample.callout.marketTime ||
            sample.features.at > sample.callout.marketTime
          )
            continue;
          const key = keyOf(sample.callout, family);
          const pool = pools.get(key) ?? [];
          pool.push(sample);
          pools.set(key, pool);
        }
        if (!pools.size)
          reports.push(`${family}: awaiting resolved, non-replay training outcomes.`);
        for (const [key, pool] of pools) {
          pool.sort(
            (a, b) => a.callout.marketTime - b.callout.marketTime || a.id.localeCompare(b.id),
          );
          const test = pool.slice(Math.floor(pool.length * 0.8));
          const testStart = test[0]!.callout.marketTime;
          // Purge overlapping label windows, plus one day of separation.
          const train = pool
            .slice(0, Math.floor(pool.length * 0.8))
            .filter((s) => s.resolved < testStart - DAY && s.observedAt < testStart - DAY);
          const successes = train.filter((s) => s.outcome === 'success').length;
          if (
            train.length < 60 ||
            test.length < 20 ||
            successes < 10 ||
            train.length - successes < 10
          ) {
            reports.push(
              `${key}: ${pool.length} decisive samples; insufficient chronological evidence (need 60 training, 20 validation, and 10 of each training label after the overlap gap).`,
            );
            continue;
          }
          const weights = fit(train);
          const baseline = successes / train.length;
          const validation: Model['validation'] = {
            count: test.length,
            brier: 0,
            baselineBrier: 0,
            avoidedFailures: 0,
            excludedSuccesses: 0,
            retained: 0,
          };
          for (const s of test) {
            const score = predict(weights, vector(s.callout, s.features));
            const target = Number(s.outcome === 'success');
            validation.brier += (score - target) ** 2 / test.length;
            validation.baselineBrier += (baseline - target) ** 2 / test.length;
            if (score >= 0.5) validation.retained++;
            else if (target) validation.excludedSuccesses++;
            else validation.avoidedFailures++;
          }
          const model: Model = {
            id: stableId(schema, day, key),
            key,
            trainedAt: now,
            cutoff,
            weights,
            trainCount: train.length,
            baseline,
            validation,
          };
          // The deployed shadow candidate is exactly the model evaluated on the untouched holdout.
          this.store.db
            .prepare('INSERT INTO learning_models(id,day,body) VALUES(?,?,?)')
            .run(model.id, day, JSON.stringify(model));
          const current = this.store.get<Model | null>(`shadow_model:${key}`, null);
          // Research snapshots keep training daily; evaluation candidates never change mid-window.
          if (
            !current?.evaluationId ||
            new LearningEvaluations(this.store).inspect(current.evaluationId)?.finalized
          ) {
            model.evaluationId = new LearningEvaluations(this.store).create(
              model.id,
              family,
              version,
              'model',
              { key, modelId: model.id, baseline, threshold: 0.5 },
              now,
            ).id;
            this.store.set(`shadow_model:${key}`, model);
          }
          reports.push(
            `${key}: ${model.id}; trained on ${train.length}, validated on ${test.length}. Brier ${validation.brier.toFixed(3)} vs constant baseline ${validation.baselineBrier.toFixed(3)} (lower is better); would exclude ${validation.avoidedFailures} failures and ${validation.excludedSuccesses} successes, retain ${validation.retained}. Offline holdout evidence only.`,
          );
        }
      }
      reports.push(
        'Shadow scores are uncalibrated experimental estimates; no live filters, public confidence scores or automatic promotions. Training uses up to 600 latest outcomes per family and active rule version; the full journal is retained.',
      );
      this.store.db
        .prepare('INSERT INTO learning_model_reports(day,body) VALUES(?,?)')
        .run(reportDay, reports.join('\n'));
      this.store.set('shadow_learning_day', day);
      this.store.set('shadow_learning_report', { day: reportDay, text: reports.join('\n') });
    });
  }
  report(): string {
    return this.store.get<{ text: string }>('shadow_learning_report', {
      text: 'Daily shadow model: awaiting the first training run.',
    }).text;
  }
}
