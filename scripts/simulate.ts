import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { replay } from '../src/research/replay.js';
import { simulate, simulationDefaults } from '../src/research/simulator.js';
import { defaults } from '../src/config.js';
const path = process.argv[2];
if (!path) throw new Error('Usage: npm run simulate -- /absolute/path/to/research-input.json');
const input = JSON.parse(await readFile(path, 'utf8'));
const datasets = Array.isArray(input) ? input : input.datasets;
const result = replay(
  datasets,
  Array.isArray(input) ? defaults : (input.strategy ?? defaults),
  Array.isArray(input) ? undefined : input.evidence,
);
const simulation = simulate(datasets, result.events, {
  ...simulationDefaults,
  ...(Array.isArray(input) ? {} : input.costs),
});
await mkdir('output', { recursive: true });
await writeFile(
  'output/simulation-report.json',
  JSON.stringify({ replay: result.report, simulation }, null, 2),
);
console.log(JSON.stringify(simulation.summary, null, 2));
console.log(
  'Saved output/simulation-report.json. Simulated executions are separate from signal references.',
);
