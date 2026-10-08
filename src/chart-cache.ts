import { stableId } from './core/strategy.js';
import type { Candidate, Dataset, SignalEvent } from './domain.js';
/** Small process-local cache; failures never poison future retries. */
export class ChartCache {
  private entries = new Map<string, { at: number; image: Buffer }>();
  private pending = new Map<string, Promise<Buffer>>();
  async render(
    data: Dataset,
    candidate: Candidate | undefined,
    tracker: SignalEvent | undefined,
    render: () => Promise<Buffer>,
    now = Date.now(),
  ): Promise<Buffer> {
    const key = stableId(data, candidate, tracker);
    for (const [id, entry] of this.entries) if (now - entry.at > 900_000) this.entries.delete(id);
    const hit = this.entries.get(key);
    if (hit) return hit.image;
    const running = this.pending.get(key);
    if (running) return running;
    const job = render()
      .then((image) => {
        if (image.length <= 250 * 1024) {
          if (this.entries.size >= 8) this.entries.delete(this.entries.keys().next().value!);
          this.entries.set(key, { at: now, image });
        }
        return image;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }
}
