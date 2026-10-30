import type { Bar, Instrument, Interval, MarketDataProvider, Session } from './domain.js';
import type { Store } from './sql-store.js';
import { DAY, QUARTER, dayStart, expectedIntraday, utcDate } from './core/time.js';
import { diagnosticCode } from './core/errors.js';
import { observeSource } from './entry-research/timing.js';
import { historyChanged } from './core/quality.js';

export interface Repair {
  instrument: Instrument;
  interval: Interval;
  from: number;
  through: number;
  cursor?: string;
  attempts: number;
  nextAttempt: number;
  status: 'pending' | 'complete' | 'unavailable';
  error?: string;
  updatedAt: number;
  unavailableRanges?: { from: number; through: number; until: number }[];
}
export const repairKey = (i: Instrument, interval: Interval) => `${i.id}:${interval}`;

export function scheduleRepair(
  store: Store,
  i: Instrument,
  interval: Interval,
  sessions: Session[],
  now: number,
) {
  const cutoff = now - (i.market === 'equity' ? 16 * 60_000 : 0),
    bars = store.bars(i, interval);
  const retained = now - (interval === '15m' ? 35 : 800) * DAY;
  const origin = Math.max(
    retained,
    store.get(`history_origin:${i.id}:${interval}`, bars[0]?.start ?? retained),
  );
  const expected =
    interval === '15m'
      ? expectedIntraday(origin, cutoff, i.market, sessions)
      : i.market === 'crypto'
        ? Array.from(
            { length: Math.max(0, Math.floor((dayStart(cutoff) - dayStart(origin)) / DAY)) },
            (_, n) => dayStart(origin) + n * DAY,
          )
        : sessions
            .filter((s) => s.open >= origin && s.close <= cutoff)
            .map((s) => Date.parse(`${s.date}T00:00:00Z`));
  const actual = new Set(bars.map((b) => b.start));
  const missing = expected.filter((t) => !actual.has(t));
  const key = repairKey(i, interval);
  const row = store.db.prepare('SELECT body FROM history_repairs WHERE id=?').get(key) as
    { body: string } | undefined;
  const old = row ? (JSON.parse(row.body) as Repair) : undefined;
  const unavailableRanges =
    old?.unavailableRanges?.filter((r) => missing.some((t) => t >= r.from && t < r.through)) ?? [];
  if (!missing.length) {
    if (old && (old.status !== 'complete' || old.unavailableRanges?.length))
      store.db.prepare('UPDATE history_repairs SET body=? WHERE id=?').run(
        JSON.stringify({
          ...old,
          status: 'complete',
          error: undefined,
          unavailableRanges: [],
          updatedAt: now,
        }),
        key,
      );
    return;
  }
  const duration = interval === '15m' ? QUARTER : DAY;
  const from = missing.find(
    (t) => !unavailableRanges.some((r) => r.until > now && t >= r.from && t < r.through),
  );
  if (from === undefined) return;
  // A bounded time range also respects Coinbase's inclusive 300-candle maximum.
  const through = Math.min(cutoff, from + 299 * duration);
  if (
    old?.status === 'pending' &&
    old.cursor &&
    missing.some((t) => t >= old.from && t < old.through)
  )
    return;
  if (old && old.status === 'pending' && old.from === from) return;
  if (old && old.from === from && old.status === 'unavailable' && old.nextAttempt > now) return;
  const job: Repair = {
    instrument: i,
    interval,
    from,
    through,
    attempts: old?.attempts ?? 0,
    nextAttempt: now,
    status: 'pending',
    updatedAt: now,
    unavailableRanges,
  };
  store.db
    .prepare(
      'INSERT INTO history_repairs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
    )
    .run(key, JSON.stringify(job));
}

export async function repairHistory(
  store: Store,
  provider: (i: Instrument) => MarketDataProvider,
  now: number,
  limit = 2,
) {
  if (store.settings().paused || store.get('budget_paused', false)) return;
  const jobs = (
    store.db.prepare('SELECT id,body FROM history_repairs ORDER BY id').all() as {
      id: string;
      body: string;
    }[]
  )
    .map((r) => ({ ...r, job: JSON.parse(r.body) as Repair }))
    .filter((r) => r.job.status !== 'complete' && r.job.nextAttempt <= now)
    .sort((a, b) => a.job.updatedAt - b.job.updatedAt || a.id.localeCompare(b.id))
    .slice(0, Math.min(2, limit));
  for (const { id, job } of jobs) {
    try {
      const adapter = provider(job.instrument);
      const page = adapter.barPage
        ? await adapter.barPage(job.instrument, job.interval, job.from, job.through, job.cursor)
        : {
            bars:
              (
                await adapter.bars(
                  [job.instrument],
                  job.interval,
                  job.from,
                  job.through + (job.instrument.market === 'equity' ? 16 * 60_000 : 0),
                )
              ).get(job.instrument.id) ?? [],
          };
      store.transaction(() => {
        if (historyChanged(store.bars(job.instrument, job.interval), page.bars))
          store.set(`history_changed:${job.instrument.id}`, true);
        store.cache(job.instrument, job.interval, page.bars);
        observeSource(store, job.instrument, job.interval, page.bars, Date.now());
        job.cursor = 'next' in page ? page.next : undefined;
        job.attempts++;
        job.status = job.cursor ? 'pending' : 'complete';
        job.error = undefined;
        job.updatedAt = now;
        job.nextAttempt = now;
        if (!page.bars.some((b) => b.start === job.from) && !job.cursor) {
          job.status = 'unavailable';
          job.error = 'PROVIDER_GAP_UNRESOLVED';
          job.nextAttempt = now + Math.min(DAY, 60_000 * 2 ** Math.min(job.attempts, 10));
          job.unavailableRanges = [
            ...(job.unavailableRanges ?? []).filter((r) => r.from !== job.from),
            { from: job.from, through: job.through, until: job.nextAttempt },
          ];
        }
        store.db
          .prepare('UPDATE history_repairs SET body=? WHERE id=?')
          .run(JSON.stringify(job), id);
      });
    } catch (error) {
      job.attempts++;
      job.error = diagnosticCode(error);
      job.updatedAt = now;
      job.nextAttempt = Math.max(
        now + Math.min(DAY, 30_000 * 2 ** Math.min(job.attempts, 10)),
        store.get(
          `retry_after:${job.instrument.market === 'crypto' ? 'api.exchange.coinbase.com' : 'data.alpaca.markets'}`,
          0,
        ),
      );
      store.db.prepare('UPDATE history_repairs SET body=? WHERE id=?').run(JSON.stringify(job), id);
      if (job.error === 'PROVIDER_WORK_LIMIT') break;
    }
  }
}

export function repairReport(store: Store) {
  const jobs = (
    store.db.prepare('SELECT body FROM history_repairs ORDER BY id').all() as { body: string }[]
  ).map((r) => JSON.parse(r.body) as Repair);
  const outsideRetention = store
    .activeIdeas()
    .filter((i) => i.lastBar < Date.now() - 35 * DAY)
    .map((i) => ({
      idea: i.candidate.id,
      symbol: i.candidate.instrument.symbol,
      requiredFrom: i.lastBar,
      reason: 'REQUIRED_HISTORY_OUTSIDE_AUTOMATIC_RETENTION',
    }));
  return {
    pending: jobs.filter((j) => j.status === 'pending').length,
    unavailable: jobs.filter((j) => j.status === 'unavailable' || j.unavailableRanges?.length)
      .length,
    jobs,
    outsideRetention,
    retention: { dailyDays: 800, intradayDays: 35 },
    note: 'Unresolved gaps are not filled with synthetic candles. History outside retained coverage requires external research history.',
  };
}
