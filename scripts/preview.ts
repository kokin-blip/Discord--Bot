import { mkdir, writeFile } from 'node:fs/promises';
import { fixture, idea } from '../tests/fixtures.js';
import { Charts } from '../src/charts.js';
import { defaults } from '../src/config.js';
import { advance } from '../src/core/strategy.js';
await mkdir('output', { recursive: true });
const charts = new Charts();
for (const direction of ['bullish', 'bearish'] as const) {
  const data = fixture(direction),
    result = advance(idea(data), data, defaults, data.provenance.asOf);
  const image = await charts.render(data, result.idea.candidate);
  await writeFile(`output/${direction}-preview.png`, image);
  console.log(`${direction}: ${image.length} bytes`);
}
