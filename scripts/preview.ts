import { mkdir, writeFile } from 'node:fs/promises';
import { fixture, idea } from '../tests/fixtures.js';
import { Charts } from '../src/charts.js';
import { defaults } from '../src/config.js';
import { DAY, QUARTER, weeklyBars } from '../src/core/time.js';
import type { Direction } from '../src/domain.js';
import { advance } from '../src/core/strategy.js';
import { publicCard } from '../src/discord/cards.js';
// Presentation fixture: varied synthetic candles, evaluated before rendering.
// Keep test fixtures untouched and never swap chart prices after qualification.
function presentationData(direction: Direction) {
  const data = fixture();
  const closeAt = (i: number) => 104 + 2 * Math.sin((i - 364) * 0.35) + (i - 364) * 0.035;
  for (let i = 364; i < 420; i++) {
    const bar = data.daily[i]!;
    bar.close = closeAt(i);
    bar.open = closeAt(i - 1);
    bar.high = Math.min(110, Math.max(bar.open, bar.close) + 1.5);
    bar.low = Math.max(100, Math.min(bar.open, bar.close) - 1.5);
    if (i === 370) {
      bar.high = 110;
      bar.low = 100;
    }
    bar.volume = 800 + 350 * Math.abs(Math.sin(i * 1.3));
  }
  const confirmation = data.intraday[0]!;
  const intraClose = (i: number) =>
    109.5 + i * 0.006 + 0.55 * Math.sin(i * 0.19) + 0.12 * Math.sin(i * 1.5);
  data.intraday = [
    ...Array.from({ length: 288 }, (_, i) => {
      const open = intraClose(i - 1),
        close = intraClose(i);
      return {
        start: confirmation.start - (288 - i) * QUARTER,
        end: confirmation.start - (287 - i) * QUARTER,
        open,
        close,
        high: Math.max(open, close) + 0.08,
        low: Math.min(open, close) - 0.08,
        volume: 20 + 20 * Math.abs(Math.sin(i * 1.3)),
      };
    }),
    confirmation,
  ];
  if (direction === 'bearish')
    for (const bar of [...data.daily, ...data.benchmark, ...data.intraday]) {
      const old = { ...bar };
      bar.open = 200 - old.open;
      bar.close = 200 - old.close;
      bar.high = 200 - old.low;
      bar.low = 200 - old.high;
    }
  // Use recent illustrative timestamps; every timeframe shifts together.
  const shift = Math.floor((Date.now() - data.provenance.asOf) / (7 * DAY)) * 7 * DAY;
  for (const bar of [...data.daily, ...data.benchmark, ...data.intraday]) {
    bar.start += shift;
    bar.end += shift;
  }
  data.provenance.asOf += shift;
  data.weekly = weeklyBars(data.daily, 'crypto', [], data.provenance.asOf);
  return data;
}
await mkdir('output', { recursive: true });
const charts = new Charts();
for (const direction of ['bullish', 'bearish'] as const) {
  const data = presentationData(direction),
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
    const image = await charts.render(frozen, event.candidate, event);
    await writeFile(`output/${name}.png`, image);
    await writeFile(
      `output/${name}-card.json`,
      JSON.stringify(publicCard(event).toJSON(), null, 2),
    );
    console.log(`${name}: ${image.length} bytes`);
  }
}
