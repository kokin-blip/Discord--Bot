import { mkdir, writeFile } from 'node:fs/promises';
import { fixture } from '../tests/fixtures.js';
import { Charts } from '../src/charts.js';
import { volumeSpike, reversalDetails, type PendingReversal } from '../src/core/trackers.js';
import { trackerEvent } from '../src/watch-trackers.js';
import { trackerCard } from '../src/discord/cards.js';
import type { SignalEvent } from '../src/domain.js';

// Synthetic layout examples only; nothing is sent to Discord.
await mkdir('output', { recursive: true });
const charts = new Charts();
const data = fixture();
const bar = data.daily.at(-1)!;
const events: SignalEvent[] = ['buying', 'selling'].map((pressure) => {
  const trigger = {
    ...bar,
    open: bar.close + (pressure === 'buying' ? -0.1 : 0.1),
    volume: 1_000_000,
  };
  return trackerEvent(data, volumeSpike(data, '1d', trigger, 2, 10)!, trigger.end);
});
const latest = data.intraday.at(-1)!;
const pending: PendingReversal = {
  id: 'synthetic-reversal-preview',
  direction: 'bullish',
  high: latest.close + 2,
  low: latest.close - 2,
  warning: latest,
  elapsed: 0,
  announced: true,
};
events.push(
  trackerEvent(
    data,
    {
      id: pending.id,
      direction: 'bullish',
      bar: latest,
      details: reversalDetails(pending, '15m', 'warning', latest.close),
    },
    latest.end,
  ),
);
for (const [index, event] of events.entries()) {
  const frozen = {
    ...data,
    daily: data.daily.filter((b) => b.end <= event.marketTime),
    weekly: data.weekly.filter((b) => b.end <= event.marketTime),
    intraday: data.intraday.filter((b) => b.end <= event.marketTime),
    provenance: event.provenance,
  };
  // Match the synthetic spike candle shown in the text card to the renderer snapshot.
  if (event.tracker?.type === 'volume')
    frozen.daily = frozen.daily.map((b) =>
      b.start === event.candidate.breakout.start ? event.candidate.breakout : b,
    );
  const image = await charts.render(frozen, undefined, event);
  const embed = trackerCard(event).setImage('attachment://chart.png');
  await writeFile(`output/tracker-${index}-preview.png`, image);
  await writeFile(`output/tracker-${index}-card.json`, JSON.stringify(embed.toJSON(), null, 2));
  console.log(`Tracker preview ${index}: ${image.length} bytes`);
}
