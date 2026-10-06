import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import type { Candidate, Dataset, SignalEvent } from './domain.js';
import { chartSnapshot } from './chart-snapshot.js';
export class Charts {
  private queue: Promise<unknown> = Promise.resolve();
  render(data: Dataset, candidate?: Candidate, tracker?: SignalEvent): Promise<Buffer> {
    const result = this.queue.then(async () =>
      chartSnapshot(
        () =>
          chromium.launch({
            headless: true,
            args: [
              '--disable-dev-shm-usage',
              '--disable-background-networking',
              '--disable-component-update',
            ],
          }),
        await readFile(new URL('./worker/chart-library.txt', import.meta.url), 'utf8'),
        data,
        candidate,
        tracker,
      ),
    );
    this.queue = result.catch(() => {});
    return result;
  }
}
