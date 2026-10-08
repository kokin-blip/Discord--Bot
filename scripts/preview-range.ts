import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { Charts } from '../src/charts.js';
import { debugSample } from '../src/discord/debug.js';
import { trackerCard } from '../src/discord/cards.js';
await mkdir('output', { recursive: true });
const charts = new Charts();
for (const type of ['range', 'combined'] as const) {
  const { data, event } = debugSample(Date.now(), `preview-${type}`, type);
  const image = await charts.render(data, undefined, event);
  await writeFile(`output/${type}-chart.png`, image);
  const embed = trackerCard(event).toJSON();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 650, height: 1100 } });
    await page.setContent(
      '<body style="margin:0;background:#313338;font-family:Arial;color:#eee"><article style="margin:20px;padding:20px;background:#2b2d31;border-left:4px solid #ef6571"><h2></h2><p></p><main></main><img style="width:100%"><footer></footer></article></body>',
    );
    await page.evaluate(
      ({ embed, image }) => {
        document.querySelector('h2')!.textContent = embed.title!;
        document.querySelector('p')!.textContent = embed.description!;
        for (const f of embed.fields!) {
          const section = document.createElement('p');
          section.textContent = `${f.name}: ${f.value}`;
          document.querySelector('main')!.append(section);
        }
        document.querySelector('img')!.src = `data:image/png;base64,${image}`;
        document.querySelector('footer')!.textContent = embed.footer!.text;
      },
      { embed, image: image.toString('base64') },
    );
    await page.screenshot({ path: `output/${type}-card-preview.png`, fullPage: true });
  } finally {
    await browser.close();
  }
  console.log(`${type}: ${image.length} bytes`);
}
