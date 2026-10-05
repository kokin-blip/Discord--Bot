import type { Bar, Instrument, Interval, MarketDataProvider } from '../domain.js';
import { crypto } from '../domain.js';
import { DAY, QUARTER } from '../core/time.js';
import { HttpClient } from './http.js';
const stablecoins = new Set([
  'USDC',
  'USDT',
  'DAI',
  'USDS',
  'GUSD',
  'PYUSD',
  'EURC',
  'PAX',
  'TUSD',
  'USDP',
  'BUSD',
]);
export class Coinbase implements MarketDataProvider {
  constructor(private http: HttpClient) {}
  async discover(): Promise<Instrument[]> {
    const rows = await this.http.json<
      {
        id: string;
        quote_currency: string;
        base_currency: string;
        status: string;
        trading_disabled?: boolean;
      }[]
    >('https://api.exchange.coinbase.com/products');
    return rows
      .filter(
        (r) =>
          r.quote_currency === 'USD' &&
          r.status === 'online' &&
          !r.trading_disabled &&
          !stablecoins.has(r.base_currency),
      )
      .map((r) => crypto(r.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  async calendar() {
    return [];
  }
  async bars(
    instruments: Instrument[],
    interval: Interval,
    start: number,
    now: number,
  ): Promise<Map<string, Bar[]>> {
    const duration = interval === '1d' ? DAY : QUARTER,
      cutoff = Math.floor(now / duration) * duration;
    const result = new Map<string, Bar[]>();
    for (const i of instruments) {
      const map = new Map<number, Bar>();
      for (
        let from = Math.floor(start / duration) * duration;
        from < cutoff;
        from += duration * 299
      ) {
        const end = Math.min(cutoff, from + duration * 299);
        const u = new URL(
          `https://api.exchange.coinbase.com/products/${encodeURIComponent(i.symbol)}/candles`,
        );
        u.search = new URLSearchParams({
          granularity: String(duration / 1000),
          start: new Date(from).toISOString(),
          end: new Date(end).toISOString(),
        }).toString();
        const rows = await this.http.json<number[][]>(u);
        for (const row of rows) {
          const [seconds, low, high, open, close, volume] = row;
          if (
            seconds === undefined ||
            low === undefined ||
            high === undefined ||
            open === undefined ||
            close === undefined ||
            volume === undefined
          )
            throw new Error('Malformed Coinbase candle');
          const t = seconds * 1000;
          if (t >= start && t + duration <= cutoff)
            map.set(t, { start: t, end: t + duration, low, high, open, close, volume });
        }
      }
      result.set(
        i.id,
        [...map.values()].sort((a, b) => a.start - b.start),
      );
    }
    return result;
  }
}
