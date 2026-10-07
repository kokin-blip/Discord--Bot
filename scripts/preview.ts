import { mkdir, writeFile } from 'node:fs/promises';
import { fixture, idea } from '../tests/fixtures.js';
import { Charts } from '../src/charts.js';
import { defaults } from '../src/config.js';
import { advance } from '../src/core/strategy.js';
import { publicCard } from '../src/discord/cards.js';
await mkdir('output', { recursive: true });
const charts = new Charts();
for (const direction of ['bullish', 'bearish'] as const) {
  const data = fixture(direction),
    result = advance(idea(data), data, defaults, data.provenance.asOf);
  for (const event of result.events) {
    const name =
      event.state === 'entry_triggered' ? `${direction}-preview` : `${direction}-setup-preview`;
    const frozen = {
      ...data,
      daily: data.daily.filter((b) => b.end <= event.marketTime),
      weekly: data.weekly.filter((b) => b.end <= event.marketTime),
      provenance: event.provenance,
    };
    const image = await charts.render(frozen, event.candidate);
    await writeFile(`output/${name}.png`, image);
    await writeFile(
      `output/${name}-card.json`,
      JSON.stringify(publicCard(event).toJSON(), null, 2),
    );
    console.log(`${name}: ${image.length} bytes`);
  }
}
