import { pathToFileURL } from 'node:url';
import { Store } from '../src/storage.js';
import { NewsStore } from '../src/news/store.js';
import { NewsIngestion } from '../src/news/ingestion.js';
import { NewsTransport } from '../src/news/transport.js';
import { MarketauxNews } from '../src/news/providers/marketaux.js';
import { CurrentsNews } from '../src/news/providers/currents.js';
import { GdeltNews } from '../src/news/providers/gdelt.js';
import { requestNewsSmoke, smokeStatus } from '../src/news/smoke.js';
import { syntheticNewsPolicy, fixtureTime } from '../src/research/news-fixtures.js';
/** No credentials, publisher requests or live provider calls. Same adapters and quota path as runtime. */
export async function syntheticNewsSmoke() {
  const store = new Store(':memory:');
  let now = fixtureTime,
    calls = 0;
  try {
    const news = new NewsStore(store, now);
    news.saveConfig({ enabled: true, providers: { marketaux: true, currents: true, gdelt: true } });
    for (const p of ['marketaux', 'currents', 'gdelt'] as const)
      for (const scope of ['provider', 'publisher'] as const)
        news.savePolicy(syntheticNewsPolicy(scope, p));
    const transport = new NewsTransport(
      async (input) => {
        calls++;
        const host = new URL(String(input)).hostname,
          url = 'https://publisher.example/synthetic',
          title = 'Federal Reserve raises interest rates';
        const body = host.includes('marketaux')
          ? {
              meta: { found: 1, returned: 1, page: 1 },
              data: [
                {
                  uuid: 'synthetic',
                  url,
                  title,
                  language: 'en',
                  published_at: new Date(now - 1000).toISOString(),
                  source: 'publisher.example',
                  entities: [],
                },
              ],
            }
          : host.includes('currents')
            ? {
                status: 'ok',
                news: [
                  {
                    id: 'synthetic',
                    url,
                    title,
                    language: 'en',
                    published: new Date(now - 1000).toISOString(),
                  },
                ],
              }
            : {
                articles: [
                  {
                    url,
                    title,
                    language: 'English',
                    seendate: new Date(now - 1000)
                      .toISOString()
                      .replace(/[-:]/g, '')
                      .replace(/\.\d{3}Z$/, 'Z'),
                  },
                ],
              };
        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
        });
      },
      () => now,
    );
    const adapters = {
      marketaux: new MarketauxNews('synthetic-only', transport),
      currents: new CurrentsNews('synthetic-only', transport),
      gdelt: new GdeltNews(transport),
    };
    const ingestion = new NewsIngestion(
      news,
      { MARKETAUX_API_TOKEN: 'synthetic-only', CURRENTS_API_KEY: 'synthetic-only' },
      () => now,
      transport,
      adapters,
    );
    requestNewsSmoke(news, 'synthetic-smoke', now, 'test');
    for (let i = 0; i < 3; i++) {
      await ingestion.tick(now);
      now += 60000;
    }
    const jobs = smokeStatus(news) as { status: string }[];
    if (calls !== 3 || jobs.length !== 3 || jobs.some((j) => j.status !== 'complete'))
      throw new Error('NEWS_SYNTHETIC_SMOKE_FAILED');
    return {
      origin: 'synthetic',
      liveCalls: 0,
      calls,
      jobs,
      metrics: ingestion.monitor.totals(now),
      productionEligible: false,
    };
  } finally {
    store.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some((a) => a !== '--help')) {
    console.error(
      'Only offline synthetic smoke is supported. Private test-channel smoke requests have been retired.',
    );
    process.exitCode = 1;
  } else if (process.argv.includes('--help'))
    console.log(
      'npm run news:smoke: offline synthetic adapters, ingestion and quota validation.\nThis tool is offline only and cannot approve live publication.',
    );
  else
    syntheticNewsSmoke()
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch(() => {
        console.error('NEWS_SYNTHETIC_SMOKE_FAILED');
        process.exitCode = 1;
      });
}
