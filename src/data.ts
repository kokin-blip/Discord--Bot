import type { Dataset, Instrument, MarketDataProvider, Session } from './domain.js';
import { benchmarkFor } from './domain.js';
import type { Store } from './sql-store.js';
import { DAY, weeklyBars, utcDate } from './core/time.js';
import { checkDaily, historyChanged } from './core/quality.js';
import { mean } from './core/indicators.js';
export class DataService {
  constructor(
    readonly store: Store,
    readonly equities: MarketDataProvider,
    readonly crypto: MarketDataProvider,
  ) {}
  provider(i: Instrument) {
    return i.market === 'equity' ? this.equities : this.crypto;
  }
  async sessions(now: number): Promise<Session[]> {
    const saved = this.store.get<{ day: string; rows: Session[] }>('calendar', {
      day: '',
      rows: [],
    });
    if (saved.day === utcDate(now)) return saved.rows;
    const rows = await this.equities.calendar(now - 800 * DAY, now + 14 * DAY);
    this.store.set('calendar', { day: utcDate(now), rows });
    return rows;
  }
  async universe(now: number): Promise<Instrument[]> {
    const cached = this.store.get<{ day: string; instruments: Instrument[] }>('universe', {
      day: '',
      instruments: [],
    });
    if (cached.day === utcDate(now)) return cached.instruments;
    type Progress = {
      day: string;
      market: 'equity' | 'crypto';
      offset: number;
      listed: Instrument[];
      liquid: { instrument: Instrument; dollar: number }[];
      selected: Instrument[];
    };
    let progress = this.store.get<Progress | null>('discovery_progress', null);
    if (!progress || progress.day !== utcDate(now))
      progress = {
        day: utcDate(now),
        market: 'equity',
        offset: 0,
        listed: await this.equities.discover(now),
        liquid: [],
        selected: [],
      };
    const provider = progress.market === 'equity' ? this.equities : this.crypto,
      limit = progress.market === 'equity' ? 300 : 50,
      minDollar = progress.market === 'equity' ? 10_000_000 : 1_000_000;
    const group = progress.listed.slice(
      progress.offset,
      progress.offset + (progress.market === 'equity' ? 500 : 10),
    );
    const bars = await provider.bars(group, '1d', now - 400 * DAY, now);
    for (const i of group) {
      const daily = bars.get(i.id) ?? [];
      if (daily.length < 252 || !daily.at(-1)) continue;
      if (i.market === 'equity' && daily.at(-1)!.close < 5) continue;
      const dollar = mean(daily.slice(-20).map((b) => b.close * b.volume));
      if (dollar >= minDollar) progress.liquid.push({ instrument: i, dollar });
    }
    progress.liquid.sort(
      (a, b) => b.dollar - a.dollar || a.instrument.id.localeCompare(b.instrument.id),
    );
    progress.liquid = progress.liquid.slice(0, limit);
    progress.offset += group.length;
    if (progress.offset >= progress.listed.length) {
      progress.selected.push(...progress.liquid.map((x) => x.instrument));
      if (progress.market === 'equity') {
        progress.market = 'crypto';
        progress.offset = 0;
        progress.listed = await this.crypto.discover(now);
        progress.liquid = [];
      } else {
        this.store.set('universe', { day: utcDate(now), instruments: progress.selected });
        this.store.set('discovery_progress', null);
        return progress.selected;
      }
    }
    this.store.set('discovery_progress', progress);
    return [];
  }
  async refreshDaily(instruments: Instrument[], now: number, force = false): Promise<void> {
    const list = [
      ...new Map(instruments.flatMap((i) => [i, benchmarkFor(i)]).map((i) => [i.id, i])).values(),
    ];
    const sessions = await this.sessions(now);
    for (const market of ['equity', 'crypto'] as const) {
      const provider = market === 'equity' ? this.equities : this.crypto;
      const stamp =
        market === 'equity'
          ? (sessions.filter((s) => s.close <= now - 16 * 60_000).at(-1)?.date ?? '')
          : utcDate(now - DAY);
      const due = list.filter(
        (i) =>
          i.market === market &&
          (force ||
            this.store.get(`history_changed:${i.id}`, false) ||
            this.store.get(`daily_refresh:${i.id}`, '') !== stamp),
      );
      const batchSize = market === 'crypto' ? 1 : 50;
      for (let offset = 0; offset < due.length; offset += batchSize) {
        const group = due.slice(offset, offset + batchSize);
        const first = group[0]!;
        const cached = this.store.bars(first, '1d');
        // Save each crypto product before fetching the next. Refresh overlapping recent
        // bars after warm-up; rebuilding 800 days on every forced scan wastes requests.
        const start =
          market === 'crypto' &&
          cached.length >= 252 &&
          !this.store.get(`history_changed:${first.id}`, false)
            ? Math.max(now - 800 * DAY, cached.at(-1)!.start - 7 * DAY)
            : now - 800 * DAY;
        const fetched = await provider.bars(group, '1d', start, now);
        for (const i of group) {
          const bars = fetched.get(i.id) ?? [];
          const changed = historyChanged(this.store.bars(i, '1d'), bars);
          this.store.cache(i, '1d', bars);
          this.store.set(`history_changed:${i.id}`, changed);
          this.store.set(`daily_refresh:${i.id}`, stamp);
        }
      }
    }
  }
  async refreshIntraday(instruments: Instrument[], now: number): Promise<void> {
    for (const market of ['equity', 'crypto'] as const) {
      const group = instruments.filter((i) => i.market === market);
      if (!group.length) continue;
      // Query enough to replay pending/active ideas after an outage; subsequent polls are incremental.
      const start = Math.min(
        ...group.map((i) => {
          const last = this.store.bars(i, '15m').at(-1);
          return last ? Math.max(now - 35 * DAY, last.start - 900_000) : now - 35 * DAY;
        }),
      );
      const fetched = await (market === 'equity' ? this.equities : this.crypto).bars(
        group,
        '15m',
        start,
        now,
      );
      for (const i of group) this.store.cache(i, '15m', fetched.get(i.id) ?? []);
    }
  }
  async dataset(i: Instrument, now: number): Promise<Dataset> {
    const sessions = await this.sessions(now),
      cutoff = now - (i.market === 'equity' ? 16 * 60_000 : 0),
      daily = this.store.bars(i, '1d'),
      benchmark = this.store.bars(benchmarkFor(i), '1d');
    checkDaily(i, daily, sessions, cutoff);
    checkDaily(benchmarkFor(i), benchmark, sessions, cutoff);
    if (
      this.store.get(`history_changed:${i.id}`, false) ||
      this.store.get(`history_changed:${benchmarkFor(i).id}`, false)
    )
      throw new Error('HISTORY_REVISED_REFRESH_REQUIRED');
    return {
      instrument: i,
      daily,
      weekly: weeklyBars(daily, i.market, sessions, cutoff),
      intraday: this.store.bars(i, '15m'),
      benchmark,
      sessions,
      provenance: {
        provider: i.market === 'equity' ? 'Alpaca' : 'Coinbase Exchange',
        feed: i.market === 'equity' ? 'SIP consolidated, adjusted' : 'Coinbase USD spot',
        delayMinutes: i.market === 'equity' ? 16 : 0,
        asOf: daily.at(-1)!.end,
      },
    };
  }
}
