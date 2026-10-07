import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { Store } from '../src/storage.js';
import { Learning } from '../src/learning.js';
import { fixture, idea } from '../tests/fixtures.js';
import { advance } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';
import { learningCard } from '../src/discord/cards.js';
import type { SignalEvent } from '../src/domain.js';
const store = new Store(':memory:');
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
try {
  const data = fixture(),
    now = data.provenance.asOf;
  const initial = advance(idea(data), data, defaults, now);
  const entry = initial.events.at(-1)!;
  store.enqueue(entry, 'crypto_ideas');
  const terminal: SignalEvent = {
    ...entry,
    id: 'synthetic-learning-failure',
    state: 'invalidated',
    marketTime: now + 900000,
    recordedAt: now + 900000,
    recovery: false,
    performance: {
      referencePrice: entry.candidate.level - 1,
      changePercent: -2,
      rMultiple: -1,
      reachedTargets: [],
      basis: 'completed_close',
      ambiguous: false,
    },
  };
  store.enqueue(terminal, 'updates');
  const learning = new Learning(store);
  learning.process(now + 900000);
  const review = store.pending(now + 900000).find((p) => p.event.kind === 'learning_review')!.event;
  const report: SignalEvent = {
    ...review,
    id: 'synthetic-learning-report',
    kind: 'learning_report',
    learningText: learning.report(),
  };
  await mkdir('output', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, event] of [
      ['failure-review', review],
      ['learning-report', report],
    ] as const) {
      const embed = learningCard({ ...event, debug: true }).toJSON();
      await writeFile(`output/${name}-preview.json`, JSON.stringify(embed, null, 2));
      const text = escape(embed.description!)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replaceAll('\n', '<br>');
      const html = `<html><body style="margin:0;padding:24px;background:#313338;color:#dbdee1;font:16px Arial"><article style="width:540px;padding:20px;border-left:4px solid ${name === 'failure-review' ? '#ef6571' : '#87939d'};border-radius:6px;background:#2b2d31"><h2 style="margin:0 0 14px;color:white;font-size:22px">${escape(embed.title!)}</h2><p style="line-height:1.5;overflow-wrap:anywhere">${text}</p><footer style="font-size:12px">Synthetic layout preview · not a real callout</footer></article></body></html>`;
      await writeFile(`output/${name}-preview.html`, html);
      const page = await browser.newPage({ viewport: { width: 620, height: 1100 } });
      await page.setContent(html);
      await page.locator('article').screenshot({ path: `output/${name}-preview.png` });
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  store.close();
}
