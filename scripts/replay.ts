import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { Dataset, Idea, SignalEvent } from '../src/domain.js';
import { terminalStates } from '../src/domain.js';
import { fixture } from '../tests/fixtures.js';
import { defaults } from '../src/config.js';
import { advance, detect, makeEvent } from '../src/core/strategy.js';
const input = process.argv[2],
  datasets: Dataset[] = input
    ? JSON.parse(await readFile(input, 'utf8'))
    : Array.from({ length: 30 }, (_, i) => fixture(i % 2 ? 'bearish' : 'bullish', i));
const all: SignalEvent[] = [];
for (const source of datasets) {
  const ideas = new Map<string, Idea>();
  for (const time of [
    ...new Set([...source.daily.map((b) => b.end), ...source.intraday.map((b) => b.end)]),
  ].sort((a, b) => a - b)) {
    const data = {
      ...source,
      daily: source.daily.filter((b) => b.end <= time),
      weekly: source.weekly.filter((b) => b.end <= time),
      intraday: source.intraday.filter((b) => b.end <= time),
      benchmark: source.benchmark.filter((b) => b.end <= time),
    };
    for (const c of detect(data, defaults, time)) {
      const existing = ideas.get(c.id);
      if (existing) {
        if (!existing.candidate.retest && c.retest) existing.candidate.retest = c.retest;
        continue;
      }
      const idea: Idea = {
        candidate: c,
        state: 'watching',
        lastBar: c.breakout.end,
        milestones: [],
        createdAt: time,
      };
      ideas.set(c.id, idea);
      all.push(makeEvent(idea, 'watching', c.breakout.end, data, time, c.reasons));
    }
    for (const [id, idea] of ideas) {
      if (terminalStates.has(idea.state)) continue;
      const r = advance(idea, data, defaults, time);
      ideas.set(id, r.idea);
      all.push(...r.events);
    }
  }
}
const real = datasets.every((d) => !d.provenance.provider.includes('synthetic'));
const report = {
  createdAt: Date.now(),
  kind: real ? 'historical replay' : 'synthetic correctness replay',
  datasets: datasets.length,
  ideas: new Set(all.map((e) => e.ideaId)).size,
  events: all.length,
  entrySignals: all.filter((e) => e.state === 'entry_triggered').length,
  states: all.reduce<Record<string, number>>(
    (a, e) => ((a[e.state] = (a[e.state] ?? 0) + 1), a),
    {},
  ),
  realHistoricalEvidence: real,
};
await mkdir('output', { recursive: true });
const contents = JSON.stringify({ report, events: all }, null, 2);
await writeFile('output/replay-report.json', contents);
console.log(JSON.stringify(report, null, 2));
console.log('Report SHA-256: ' + createHash('sha256').update(contents).digest('hex'));
if (!real)
  console.log('Synthetic fixtures cannot satisfy the historical-review release checkpoint.');
