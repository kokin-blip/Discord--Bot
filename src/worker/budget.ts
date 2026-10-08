import type { Store } from '../sql-store.js';
import type { CloudSql } from './sql.js';
export class CloudBudget {
  readonly imageLimit = 60;
  constructor(
    readonly store: Store,
    readonly sql: CloudSql,
  ) {}
  tick(now: number): boolean {
    const day = new Date(now).toISOString().slice(0, 10),
      usage = this.store.get('cloud_usage', {
        day,
        reads: 0,
        writes: 0,
        requests: 0,
        browserSeconds: 0,
        images: 0,
        lastBrowser: 0,
      });
    if (usage.day !== day) {
      usage.day = day;
      usage.reads = 0;
      usage.writes = 0;
      usage.requests = 0;
      usage.browserSeconds = 0;
      usage.images = 0;
      usage.lastBrowser = 0;
    }
    usage.reads += this.sql.reads;
    usage.writes += this.sql.writes;
    usage.requests++;
    this.sql.reads = 0;
    this.sql.writes = 0;
    const paused =
      usage.reads >= 4_000_000 ||
      usage.writes >= 80_000 ||
      usage.requests >= 80_000 ||
      (this.sql.storage?.sql.databaseSize ?? 0) >= 4_000_000_000;
    this.store.set('cloud_usage', usage);
    this.store.set('budget_paused', paused);
    return !paused;
  }
  reserveBrowser(now: number, entry = false): boolean {
    const u = this.store.get('cloud_usage', {
      day: '',
      reads: 0,
      writes: 0,
      requests: 0,
      browserSeconds: 0,
      images: 0,
      lastBrowser: 0,
    });
    if (
      this.store.get('budget_paused', false) ||
      u.browserSeconds + 60 > (entry ? 480 : 360) ||
      now - u.lastBrowser < 20_000 ||
      u.images >= 60
    )
      return false;
    u.browserSeconds += 60;
    u.lastBrowser = now;
    this.store.set('cloud_usage', u);
    return true;
  }
  image(_now: number, bytes: number): boolean {
    const u = this.store.get('cloud_usage', { images: 0 });
    if (bytes > 250 * 1024 || u.images >= 60 || this.store.get('budget_paused', false))
      return false;
    u.images++;
    this.store.set('cloud_usage', u);
    return true;
  }
  status() {
    return {
      paused: this.store.get('budget_paused', false),
      usage: this.store.get('cloud_usage', {}),
      storageBytes: this.sql.storage?.sql.databaseSize ?? 0,
      limits: {
        reads: 4_000_000,
        writes: 80_000,
        requests: 80_000,
        browserSeconds: 480,
        imageBytes: 250 * 1024,
        images: 60,
        storageBytes: 4_000_000_000,
      },
    };
  }
}
