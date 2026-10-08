import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fixture } from '../tests/fixtures.js';
import { defaults } from '../src/config.js';
import { replay } from '../src/research/replay.js';
const input = process.argv[2];
const parsed = input
  ? JSON.parse(await readFile(input, 'utf8'))
  : {
      datasets: Array.from({ length: 30 }, (_, i) => {
        const data = fixture(i % 2 ? 'bearish' : 'bullish', i);
        data.instrument = { ...data.instrument, id: `synthetic:${i}`, symbol: `FIXTURE${i}-USD` };
        return data;
      }),
      strategy: defaults,
    };
const result = replay(
  Array.isArray(parsed) ? parsed : parsed.datasets,
  Array.isArray(parsed) ? defaults : (parsed.strategy ?? defaults),
  Array.isArray(parsed) ? undefined : parsed.evidence,
);
await mkdir('output', { recursive: true });
const contents = JSON.stringify(result, null, 2);
await writeFile('output/replay-report.json', contents);
console.log(JSON.stringify(result.report, null, 2));
console.log('Report SHA-256: ' + createHash('sha256').update(contents).digest('hex'));
if (!result.report.realHistoricalEvidence)
  console.log(
    'Unverified or synthetic data cannot satisfy historical review. Supply a source evidence manifest and review it.',
  );
