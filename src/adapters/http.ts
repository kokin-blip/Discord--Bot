import type { Store } from '../sql-store.js';
export class HttpClient {
  private last = new Map<string, number>();
  constructor(
    private store?: Store,
    private fetcher: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  async json<T>(url: URL | string, headers: Record<string, string> = {}): Promise<T> {
    const host = new URL(url).hostname,
      minGap = host.includes('coinbase') ? 400 : 350;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (this.store?.get('budget_paused', false)) throw new Error('EGRESS_BUDGET_PAUSED');
      const blocked = this.store?.get(`retry_after:${host}`, 0) ?? 0;
      if (blocked > Date.now()) throw new Error('PROVIDER_RETRY_LATER');
      const wait = minGap - (Date.now() - (this.last.get(host) ?? 0));
      if (wait > 0) await this.sleep(wait);
      this.last.set(host, Date.now());
      let response: Response;
      try {
        response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(20_000) });
      } catch {
        if (attempt === 4) throw new Error(`NETWORK_UNAVAILABLE:${host}`);
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (response.ok) return (await response.json()) as T;
      if (response.status !== 429 && response.status < 500)
        throw new Error(`DATA_HTTP_${response.status}:${host}`);
      const retry = response.headers.get('retry-after');
      const seconds = retry ? Number(retry) : NaN;
      const delay = retry
        ? Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retry) - Date.now()
        : 1000 * 2 ** attempt;
      await response.body?.cancel();
      const remaining = Math.max(0, delay);
      if (remaining > 60_000) {
        this.store?.set(`retry_after:${host}`, Date.now() + remaining);
        throw new Error('PROVIDER_RETRY_LATER');
      }
      if (attempt === 4) throw new Error(`DATA_HTTP_${response.status}:${host}`);
      await this.sleep(remaining);
    }
    throw new Error('Request exhausted');
  }
}
