import { createHash } from 'node:crypto';
import type { Bar, Candidate, Dataset, Direction, Idea, SignalEvent, State } from '../domain.js';
import { terminalStates } from '../domain.js';
import type { StrategyConfig } from '../config.js';
import { defaults } from '../config.js';
import { atr, mean, relativeStrength, sma } from './indicators.js';
import { completed, sessionsAfter, validateBars } from './time.js';
export const stableId = (...parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
export const strategyVersion = (config: StrategyConfig) => `br-v1-${stableId(config)}`;
const sign = (direction: Direction) => (direction === 'bullish' ? 1 : -1);
export function pivotLevels(daily: Bar[], direction: Direction, lookback: number): number[] {
  const s = sign(direction),
    pivots: number[] = [],
    bars = daily.slice(-lookback);
  for (let i = 2; i < bars.length - 2; i++) {
    const b = bars[i]!,
      value = s === 1 ? b.high : b.low;
    const neighbors = [bars[i - 2]!, bars[i - 1]!, bars[i + 1]!, bars[i + 2]!];
    if (neighbors.every((n) => s * (value - (s === 1 ? n.high : n.low)) > 0)) pivots.push(value);
  }
  return [...new Set(pivots)].sort((a, b) => s * (a - b));
}
export function targetFor(
  daily: Bar[],
  entry: number,
  level: number,
  width: number,
  direction: Direction,
  lookback: number,
): number {
  const s = sign(direction);
  return (
    pivotLevels(daily, direction, lookback).find((value) => s * (value - entry) > 0) ??
    level + s * width
  );
}
export function detect(data: Dataset, config: StrategyConfig, now: number): Candidate[] {
  const daily = completed(data.daily, now),
    weekly = completed(data.weekly, now),
    benchmark = completed(data.benchmark, now);
  validateBars(daily);
  validateBars(weekly);
  validateBars(benchmark);
  if (
    daily.length <
    Math.max(config.marketPeriod, config.volumePeriod + config.atrPeriod + 1, config.rsPeriod + 1)
  )
    return [];
  const results: Candidate[] = [];
  // Reconstruct each breakout using only data available at that close, not today's weekly base.
  for (
    let i = Math.max(config.marketPeriod, config.volumePeriod + config.atrPeriod + 1);
    i < daily.length;
    i++
  ) {
    const breakout = daily[i]!;
    if (
      sessionsAfter(breakout.end, now, data.instrument.market, data.sessions) >
      config.retestBars + config.confirmationSessions
    )
      continue;
    const prior = daily.slice(0, i),
      w = weekly.filter((b) => b.end <= breakout.start),
      refs = benchmark.filter((b) => b.end <= breakout.end);
    if (
      w.length < Math.max(config.weeklyPeriod + config.slopeWeeks, config.baseWeeks) ||
      refs.length < config.marketPeriod
    )
      continue;
    const a = atr(prior, config.atrPeriod),
      base = w.slice(-config.baseWeeks),
      high = Math.max(...base.map((b) => b.high)),
      low = Math.min(...base.map((b) => b.low));
    if (!Number.isFinite(a) || a <= 0 || (high - low) / ((high + low) / 2) > config.maxBaseWidth)
      continue;
    const current = sma(w, config.weeklyPeriod),
      old = sma(w.slice(0, -config.slopeWeeks), config.weeklyPeriod),
      slope = current / old - 1;
    const rs = relativeStrength([...prior, breakout], refs, config.rsPeriod);
    const rvol = breakout.volume / mean(prior.slice(-config.volumePeriod).map((b) => b.volume));
    for (const direction of ['bullish', 'bearish'] as const) {
      const s = sign(direction),
        level = s === 1 ? high : low,
        entry = level + s * 0.5 * a;
      const selfBTC = data.instrument.market === 'crypto' && data.instrument.symbol === 'BTC-USD';
      if (
        s * (w.at(-1)!.close - current) <= 0 ||
        s * slope < -config.flatSlope ||
        s * (breakout.close - level) < config.breakoutBuffer * a ||
        rvol < config.breakoutVolume ||
        (!selfBTC && (!Number.isFinite(rs) || s * rs <= 0)) ||
        s * (refs.at(-1)!.close - sma(refs, config.marketPeriod)) <= 0
      )
        continue;
      const target = targetFor(prior, entry, level, high - low, direction, config.pivotLookback),
        rr = (s * (target - entry)) / Math.abs(entry - level);
      if (rr < config.minimumRR) continue;
      const candidate: Candidate = {
        id: stableId(data.instrument.id, direction, breakout.start, strategyVersion(config)),
        instrument: data.instrument,
        direction,
        strategyVersion: strategyVersion(config),
        breakout,
        level,
        baseHigh: high,
        baseLow: low,
        atr: a,
        relativeStrength: selfBTC ? 0 : rs,
        relativeVolume: rvol,
        provisionalRR: rr,
        reasons: [
          'Weekly trend qualified',
          `${config.baseWeeks}-week base and volume breakout qualified`,
          selfBTC ? 'BTC self-comparison skipped' : 'Directional relative strength qualified',
          'Benchmark trend qualified',
          `At least ${config.minimumRR}R room to target`,
        ],
      };
      const following = daily.slice(i + 1, i + 1 + config.retestBars);
      for (let j = 0; j < following.length; j++) {
        const b = following[j]!,
          extreme = s === 1 ? b.low : b.high,
          history = daily.slice(0, i + 1 + j);
        // Any completed daily close back through the level invalidates the pending setup.
        if (s * (b.close - level) < 0) break;
        if (
          Math.abs(extreme - level) <= config.retestTolerance * a &&
          s * (b.close - b.open) > 0 &&
          s * (b.close - (b.high + b.low) / 2) >= 0 &&
          b.volume <=
            config.retestVolume * mean(history.slice(-config.volumePeriod).map((x) => x.volume))
        ) {
          candidate.retest = b;
          candidate.reasons.push('Low-volume daily retest qualified');
          break;
        }
      }
      results.push(candidate);
    }
  }
  return results;
}
export function rank(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.provisionalRR - a.provisionalRR ||
      sign(b.direction) * b.relativeStrength - sign(a.direction) * a.relativeStrength ||
      b.relativeVolume - a.relativeVolume ||
      a.instrument.id.localeCompare(b.instrument.id) ||
      a.id.localeCompare(b.id),
  );
}
export function makeEvent(
  idea: Idea,
  state: State,
  marketTime: number,
  data: Dataset,
  now: number,
  reasons: string[],
  observations?: string[],
  config: StrategyConfig = defaults,
): SignalEvent {
  const candidate = structuredClone(idea.candidate);
  if (candidate.retest && candidate.retest.end > marketTime) {
    delete candidate.retest;
    candidate.reasons = candidate.reasons.filter((r) => r !== 'Low-volume daily retest qualified');
  }
  const s = sign(candidate.direction),
    totalSessions = candidate.retest ? config.confirmationSessions : config.retestBars,
    remainingSessions = Math.max(
      0,
      totalSessions -
        sessionsAfter(
          candidate.retest?.end ?? candidate.breakout.end,
          marketTime,
          data.instrument.market,
          data.sessions,
        ),
    );
  return {
    kind: 'lifecycle',
    setupContext:
      candidate.entry === undefined
        ? {
            entryBand: [
              candidate.level + s * config.minChase * candidate.atr,
              candidate.level + s * config.maxChase * candidate.atr,
            ].sort((a, b) => a - b) as [number, number],
            remainingSessions,
            totalSessions,
          }
        : undefined,
    id: stableId(idea.candidate.id, state, marketTime),
    ideaId: idea.candidate.id,
    instrument: idea.candidate.instrument,
    direction: idea.candidate.direction,
    state,
    marketTime,
    recordedAt: now,
    strategyVersion: idea.candidate.strategyVersion,
    candidate,
    provenance: { ...data.provenance, asOf: marketTime },
    reasons,
    observations,
  };
}
export function advance(
  original: Idea,
  data: Dataset,
  config: StrategyConfig,
  now: number,
  allowEntry = true,
): { idea: Idea; events: SignalEvent[] } {
  const idea = structuredClone(original),
    events: SignalEvent[] = [],
    s = sign(idea.candidate.direction),
    c = idea.candidate;
  if (terminalStates.has(idea.state)) return { idea, events };
  const emit = (state: State, time: number, reasons: string[], observations?: string[]) => {
    idea.state = state;
    events.push(makeEvent(idea, state, time, data, now, reasons, observations, config));
  };
  for (const b of completed(data.intraday, now)) {
    if (b.end <= idea.lastBar || b.end <= c.breakout.end) continue;
    if (idea.state === 'watching' && c.retest && b.start >= c.retest.end)
      emit('setup_ready', c.retest.end, ['Retest complete; awaiting 15-minute confirmation']);
    idea.lastBar = b.end;
    if (s * (b.close - c.level) < 0) {
      emit(
        'invalidated',
        b.end,
        ['15-minute candle closed through breakout level'],
        c.entry === undefined ? undefined : observations(b, c, s),
      );
      break;
    }
    if (c.entry === undefined) {
      if (!c.retest || b.start < c.retest.end) continue;
      if (
        sessionsAfter(c.retest.end, b.start, data.instrument.market, data.sessions) >=
        config.confirmationSessions
      ) {
        emit('expired', b.end, ['Entry confirmation window elapsed']);
        break;
      }
      if (s * (b.close - (s === 1 ? c.retest.high : c.retest.low)) <= 0) continue;
      const distance = s * (b.close - c.level),
        target = targetFor(
          data.daily.filter((d) => d.end <= c.breakout.start),
          b.close,
          c.level,
          c.baseHigh - c.baseLow,
          c.direction,
          config.pivotLookback,
        );
      if (distance > config.maxChase * c.atr) {
        emit('expired', b.end, ['Confirmation exceeded chase limit']);
        break;
      }
      if (distance < config.minChase * c.atr) continue;
      if ((s * (target - b.close)) / distance < config.minimumRR) {
        emit('expired', b.end, ['Confirmation offers less than minimum reward/risk']);
        break;
      }
      if (!allowEntry) continue;
      c.entry = b.close;
      c.target = target;
      c.targets = [b.close + s * distance, b.close + s * 2 * distance, target];
      c.confirmedAt = b.end;
      emit('entry_triggered', b.end, [
        '15-minute confirmation; price is a signal reference, not a fill',
      ]);
      continue; // The confirming candle's high/low predates the reference entry.
    }
    for (let i = 0; i < 3; i++) {
      const target = c.targets![i]!;
      if (!idea.milestones.includes(i) && s * ((s === 1 ? b.high : b.low) - target) >= 0) {
        idea.milestones.push(i);
        emit((['target_1', 'target_2', 'final_target'] as const)[i]!, b.end, [
          'Price touched target; no fill or realized return inferred',
        ]);
      }
    }
    if (terminalStates.has(idea.state)) break;
    if (
      sessionsAfter(c.confirmedAt!, b.end, data.instrument.market, data.sessions) >=
      config.exitSessions
    ) {
      emit('time_exit', b.end, [`${config.exitSessions}-session time window elapsed`]);
      break;
    }
  }
  if (idea.state === 'watching' && c.retest && c.retest.end <= now)
    emit('setup_ready', c.retest.end, ['Retest complete; awaiting 15-minute confirmation']);
  if (!terminalStates.has(idea.state) && c.entry === undefined) {
    const origin = c.retest?.end ?? c.breakout.end,
      limit = c.retest ? config.confirmationSessions : config.retestBars;
    if (sessionsAfter(origin, now, data.instrument.market, data.sessions) >= limit)
      emit('expired', now, ['Setup window elapsed without entry']);
  }
  return { idea, events };
}
function observations(b: Bar, c: Candidate, s: number): string[] {
  const touched = c.targets?.filter((t) => s * ((s === 1 ? b.high : b.low) - t) >= 0) ?? [];
  return touched.length
    ? [
        'Target touch and close-based invalidation in same candle; intrabar ordering unknown; no winning outcome assumed',
      ]
    : [];
}
