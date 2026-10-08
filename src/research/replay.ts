import { createHash } from 'node:crypto';
import type { Dataset, Idea, SignalEvent } from '../domain.js';
import { terminalStates } from '../domain.js';
import { strategySchema, type StrategyConfig } from '../config.js';
import { advance, detect, findRetest, makeEvent, strategyVersion } from '../core/strategy.js';
import { checkDaily, checkIntraday } from '../core/quality.js';
import { validateBars, weeklyBars } from '../core/time.js';

export interface HistoricalEvidence {
  source: string;
  retrievedAt: string;
  sourceSha256: string;
}
export function replay(
  datasets: Dataset[],
  config: StrategyConfig,
  evidence?: HistoricalEvidence[],
) {
  config = strategySchema.parse(config);
  if (!datasets.length) throw new Error('Replay requires at least one dataset');
  if (new Set(datasets.map((d) => d.instrument.id)).size !== datasets.length)
    throw new Error('Replay requires one coherent dataset per instrument');
  const historical =
    !!evidence &&
    evidence.length === datasets.length &&
    evidence.every(
      (e) =>
        e.source.trim() &&
        Number.isFinite(Date.parse(e.retrievedAt)) &&
        /^[a-f0-9]{64}$/i.test(e.sourceSha256),
    ) &&
    datasets.every((d) => !/synthetic/i.test(d.provenance.provider + d.provenance.feed));
  if (evidence && !historical) throw new Error('Invalid historical evidence manifest');
  for (const d of datasets) {
    for (const bars of [d.daily, d.intraday, d.benchmark]) validateBars(bars);
    if (historical) {
      const end = Math.max(...d.daily.map((b) => b.end), ...d.intraday.map((b) => b.end));
      checkDaily(d.instrument, d.daily, d.sessions, end);
      checkDaily(d.instrument, d.benchmark, d.sessions, end);
      if (!d.intraday.length) throw new Error('Historical replay requires intraday history');
      checkIntraday(d, d.intraday[0]!.start, end);
    }
  }
  const ideas = new Map<string, Idea>();
  const events: SignalEvent[] = [];
  const times = [
    ...new Set(datasets.flatMap((d) => [...d.daily, ...d.intraday].map((b) => b.end))),
  ].sort((a, b) => a - b);
  for (const time of times)
    for (const source of datasets) {
      const data = {
        ...source,
        daily: source.daily.filter((b) => b.end <= time),
        intraday: source.intraday.filter((b) => b.end <= time),
        benchmark: source.benchmark.filter((b) => b.end <= time),
      };
      data.weekly = weeklyBars(data.daily, data.instrument.market, data.sessions, time);
      const active = () => [...ideas.values()].filter((i) => !terminalStates.has(i.state));
      for (const c of detect(data, config, time).sort((a, b) => b.breakout.end - a.breakout.end)) {
        if (
          ideas.has(c.id) ||
          active().length >= 20 ||
          active().some(
            (i) =>
              i.candidate.instrument.id === c.instrument.id &&
              i.candidate.direction === c.direction,
          )
        )
          continue;
        if (historical) checkIntraday(data, c.breakout.end, time);
        const idea: Idea = {
          candidate: c,
          state: 'watching',
          lastBar: c.breakout.end,
          milestones: [],
          createdAt: time,
        };
        ideas.set(c.id, idea);
        events.push(
          makeEvent(idea, 'watching', c.breakout.end, data, time, c.reasons, undefined, config),
        );
      }
      for (const [id, idea] of ideas) {
        if (idea.candidate.instrument.id !== data.instrument.id || terminalStates.has(idea.state))
          continue;
        if (!idea.candidate.retest)
          idea.candidate.retest = findRetest(data, idea.candidate, config, time);
        const result = advance(
          idea,
          data,
          config,
          time,
          active().filter((i) => i.candidate.entry !== undefined).length < 20 ||
            idea.candidate.entry !== undefined,
        );
        ideas.set(id, result.idea);
        events.push(...result.events);
      }
    }
  return {
    report: {
      kind: historical
        ? 'manifest-backed historical replay; administrator source review required'
        : 'unverified correctness replay',
      realHistoricalEvidence: historical,
      datasets: datasets.length,
      strategyVersion: strategyVersion(config),
      config,
      evidence,
      inputSha256: createHash('sha256').update(JSON.stringify(datasets)).digest('hex'),
      ideas: ideas.size,
      events: events.length,
      entrySignals: events.filter((e) => e.state === 'entry_triggered').length,
      states: events.reduce<Record<string, number>>((a, e) => {
        a[e.state] = (a[e.state] ?? 0) + 1;
        return a;
      }, {}),
      limitations:
        'Rule fidelity only; no fills or profitability. Daily/15m completed-candle evaluation; live discovery, routing, recovery and polling delays require separate integration validation.',
    },
    events,
  };
}
