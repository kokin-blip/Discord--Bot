import type {
  Bar,
  Instrument,
  Interval,
  MarketDataProvider,
  OptionsContext,
  Session,
} from '../domain.js';
import { equity } from '../domain.js';
import { DAY, QUARTER, utcDate } from '../core/time.js';
import { HttpClient } from './http.js';
interface RawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export class Alpaca implements MarketDataProvider {
  readonly headers: Record<string, string>;
  constructor(
    private http: HttpClient,
    key: string,
    secret: string,
  ) {
    this.headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  }
  beginWork() {
    this.http.beginWork();
  }
  endWork() {
    this.http.endWork();
  }
  async discover(): Promise<Instrument[]> {
    const rows = await this.http.json<{ symbol: string; status: string; exchange: string }[]>(
      'https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity',
      this.headers,
    );
    return rows
      .filter(
        (r) =>
          r.status === 'active' &&
          ['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'BATS', 'NYSEARCA'].includes(r.exchange),
      )
      .map((r) => equity(r.symbol))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  private calendarCache?: { start: number; end: number; at: number; rows: Session[] };
  async calendar(start: number, end: number): Promise<Session[]> {
    const cached = this.calendarCache;
    if (cached && cached.start <= start && cached.end >= end && Date.now() - cached.at < DAY)
      return cached.rows.filter(
        (s) => Date.parse(s.date) >= Math.floor(start / DAY) * DAY && Date.parse(s.date) <= end,
      );
    const u = new URL('https://paper-api.alpaca.markets/v2/calendar');
    u.searchParams.set('start', utcDate(start));
    u.searchParams.set('end', utcDate(end));
    const rows = await this.http.json<{ date: string; open: string; close: string }[]>(
      u,
      this.headers,
    );
    const sessions = rows.map((r) => ({
      date: r.date,
      open: nyTime(r.date, r.open),
      close: nyTime(r.date, r.close),
    }));
    this.calendarCache = { start, end, at: Date.now(), rows: sessions };
    return sessions;
  }
  async bars(
    instruments: Instrument[],
    interval: Interval,
    start: number,
    now: number,
  ): Promise<Map<string, Bar[]>> {
    const result = new Map(instruments.map((i) => [i.id, [] as Bar[]]));
    const cutoff = now - 16 * 60_000;
    if (cutoff <= start || !instruments.length) return result;
    const sessions = await this.calendar(start, now),
      byDate = new Map(sessions.map((s) => [s.date, s]));
    for (let offset = 0; offset < instruments.length; offset += 100) {
      const chunk = instruments.slice(offset, offset + 100);
      let token: string | undefined;
      do {
        const u = new URL('https://data.alpaca.markets/v2/stocks/bars');
        u.search = new URLSearchParams({
          symbols: chunk.map((i) => i.symbol).join(','),
          timeframe: interval === '1d' ? '1Day' : '15Min',
          start: new Date(start).toISOString(),
          end: new Date(cutoff).toISOString(),
          feed: 'sip',
          adjustment: 'all',
          sort: 'asc',
          limit: '10000',
        }).toString();
        if (token) u.searchParams.set('page_token', token);
        const response = await this.http.json<{
          bars: Record<string, RawBar[]>;
          next_page_token?: string;
        }>(u, this.headers);
        for (const i of chunk)
          for (const b of response.bars[i.symbol] ?? []) {
            const date = new Intl.DateTimeFormat('en-CA', {
              timeZone: 'America/New_York',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            }).format(new Date(b.t));
            const session = byDate.get(date);
            if (!session) continue;
            const time = interval === '1d' ? Date.parse(`${date}T00:00:00Z`) : Date.parse(b.t),
              end = interval === '1d' ? session.close : time + QUARTER;
            if (
              end > cutoff ||
              (interval === '15m' && (time < session.open || end > session.close))
            )
              continue;
            result
              .get(i.id)!
              .push({ start: time, end, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
          }
        token = response.next_page_token;
      } while (token);
    }
    return result;
  }
  async options(
    i: Instrument,
    context?: { direction: 'bullish' | 'bearish'; price: number; now: number },
  ): Promise<OptionsContext[]> {
    if (!context || !Number.isFinite(context.price) || context.price <= 0) return [];
    const u = new URL(
      `https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(i.symbol)}`,
    );
    u.search = 'feed=indicative&limit=100';
    const r = await this.http.json<{
      snapshots: Record<
        string,
        {
          impliedVolatility?: number;
          greeks?: Record<string, number>;
          latestQuote?: { bp: number; ap: number; bs: number; as: number; t: string };
        }
      >;
    }>(u, this.headers);
    return Object.entries(r.snapshots ?? {})
      .flatMap(([contract, s]): OptionsContext[] => {
        const match = contract.match(/(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
        if (!match || match[4] !== (context.direction === 'bullish' ? 'C' : 'P')) return [];
        const expiry = `20${match[1]}-${match[2]}-${match[3]}`,
          days = (Date.parse(expiry) - context.now) / DAY,
          strike = Number(match[5]) / 1000;
        const q = s.latestQuote,
          at = q ? Date.parse(q.t) : NaN;
        if (
          days < 14 ||
          days > 90 ||
          Math.abs(strike / context.price - 1) > 0.15 ||
          !q ||
          ![q.bp, q.ap, q.bs, q.as, at].every(Number.isFinite) ||
          q.bp <= 0 ||
          q.ap < q.bp ||
          q.bs < 1 ||
          q.as < 1 ||
          context.now - at > 30 * 60000 ||
          at > context.now
        )
          return [];
        const spread = (100 * (q.ap - q.bp)) / ((q.ap + q.bp) / 2);
        if (spread > 20) return [];
        return [
          {
            contract,
            expiry,
            strike,
            bid: q.bp,
            ask: q.ap,
            spreadPercent: spread,
            iv: s.impliedVolatility,
            delta: s.greeks?.delta,
            gamma: s.greeks?.gamma,
            theta: s.greeks?.theta,
            vega: s.greeks?.vega,
            asOf: at,
          },
        ];
      })
      .sort(
        (a, b) =>
          Math.abs(a.strike! / context.price - 1) - Math.abs(b.strike! / context.price - 1) ||
          a.spreadPercent! - b.spreadPercent! ||
          a.expiry.localeCompare(b.expiry),
      )
      .slice(0, 6);
  }
}
export function nyTime(date: string, clock: string): number {
  const utc = Date.parse(`${date}T${clock.length === 5 ? clock + ':00' : clock}Z`);
  const local = new Date(utc + 12 * 3_600_000);
  const offset = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(local)
    .find((p) => p.type === 'timeZoneName')!.value;
  const hours = Number(offset.replace('GMT', ''));
  return utc - hours * 3_600_000;
}
