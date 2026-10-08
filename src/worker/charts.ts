import { ChartCache } from '../chart-cache.js';
import puppeteer from '@cloudflare/puppeteer';
import type { Candidate, Dataset, SignalEvent } from '../domain.js';
import type { Env } from './types.js';
import type { CloudBudget } from './budget.js';
import { chartSnapshot } from '../chart-snapshot.js';
import library from './chart-library.txt';
export class CloudCharts {
  private cache = new ChartCache();
  constructor(
    readonly env: Env,
    readonly budget: CloudBudget,
  ) {}
  async render(data: Dataset, candidate?: Candidate, tracker?: SignalEvent): Promise<Buffer> {
    return this.cache.render(data, candidate, tracker, () =>
      this.renderFresh(data, candidate, tracker),
    );
  }
  private async renderFresh(
    data: Dataset,
    candidate?: Candidate,
    tracker?: SignalEvent,
  ): Promise<Buffer> {
    if (!this.budget.reserveBrowser(Date.now(), tracker?.state === 'entry_triggered'))
      throw new Error('BROWSER_FREE_ALLOWANCE_UNAVAILABLE');
    let active: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        void active?.close().catch(() => {});
        reject(new Error('CHART_RENDER_TIMEOUT'));
      }, 15_000);
    });
    const job = chartSnapshot(
      async () => {
        const browser = await puppeteer.launch(
          this.env.BROWSER as unknown as Parameters<typeof puppeteer.launch>[0],
          { keep_alive: 20_000 },
        );
        active = browser;
        if (expired) {
          await browser.close();
          throw new Error('CHART_RENDER_TIMEOUT');
        }
        return {
          close: () => browser.close(),
          newPage: async ({ viewport }: { viewport: { width: number; height: number } }) => {
            const page = await browser.newPage();
            await page.setViewport(viewport);
            page.setDefaultTimeout(10_000);
            return {
              route: async () => {
                await page.setRequestInterception(true);
                page.on('request', (request) => void request.abort());
              },
              setContent: page.setContent.bind(page),
              addScriptTag: page.addScriptTag.bind(page),
              evaluate: page.evaluate.bind(page),
              screenshot: page.screenshot.bind(page),
            };
          },
        };
      },
      library,
      data,
      candidate,
      tracker,
    );
    try {
      return await Promise.race([job, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
