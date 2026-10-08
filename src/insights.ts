import { benchmarkTrend } from './core/learning-features.js';
import { relativeStrength } from './core/indicators.js';
import type { Store } from './sql-store.js';
import { benchmarkFor, type Dataset, type Instrument, type SignalEvent } from './domain.js';
import { weeklyBars, sessionsAfter, DAY } from './core/time.js';
import { checkDaily } from './core/quality.js';
import { detect, strategyVersion, type QualificationAttempt } from './core/strategy.js';
import { productionBlockers } from './worker/publication.js';

export function cachedDataset(store: Store, instrument: Instrument, now: number): Dataset {
  const sessions =
    instrument.market === 'equity'
      ? store.get<{ rows: Dataset['sessions'] }>('calendar', { rows: [] }).rows
      : [];
  const daily = store.bars(instrument, '1d');
  const cutoff = now - (instrument.market === 'equity' ? 16 * 60_000 : 0);
  return {
    instrument,
    daily,
    intraday: store.bars(instrument, '15m'),
    benchmark: store.bars(benchmarkFor(instrument), '1d'),
    sessions,
    weekly: weeklyBars(daily, instrument.market, sessions, cutoff),
    provenance: {
      provider: 'Cached monitoring data',
      feed: instrument.venue,
      delayMinutes: instrument.market === 'equity' ? 16 : 0,
      asOf: daily.at(-1)?.end ?? 0,
    },
  };
}
export function explain(store: Store, instrument: Instrument, now: number) {
  const data = cachedDataset(store, instrument, now);
  const config = store.strategy();
  const attempts: QualificationAttempt[] = [];
  let quality: string | undefined;
  try {
    checkDaily(instrument, data.daily, data.sessions, now - data.provenance.delayMinutes * 60_000);
    checkDaily(
      benchmarkFor(instrument),
      data.benchmark,
      data.sessions,
      now - data.provenance.delayMinutes * 60_000,
    );
    if (
      store.get(`history_changed:${instrument.id}`, false) ||
      store.get(`history_changed:${benchmarkFor(instrument).id}`, false)
    )
      throw new Error('HISTORY_REVISED_REFRESH_REQUIRED');
  } catch (e) {
    quality = e instanceof Error ? e.message : 'DATA_UNAVAILABLE';
  }
  const candidates = quality
    ? []
    : detect(data, config, now - data.provenance.delayMinutes * 60_000, (a) => attempts.push(a));
  return {
    symbol: instrument.symbol,
    asOf: data.provenance.asOf,
    strategyVersion: strategyVersion(config),
    quality: quality ?? store.get(`quality:${instrument.id}`, null),
    attempts: (['bullish', 'bearish'] as const)
      .map((d) => attempts.filter((a) => a.direction === d).at(-1))
      .filter(Boolean),
    candidates: candidates.map((c) => ({
      id: c.id,
      direction: c.direction,
      breakout: c.breakout.end,
      retest: c.retest?.end,
      reasons: c.reasons,
    })),
    activeIdeas: store
      .activeIdeas()
      .filter((i) => i.candidate.instrument.id === instrument.id)
      .map((i) => ({ id: i.candidate.id, state: i.state, version: i.candidate.strategyVersion })),
    note: attempts.length
      ? 'Checks use the same detector as monitoring. Latest attempted candle per direction; qualification is not an entry. Retests and confirmations use each open idea’s original rules.'
      : 'No evaluable recent breakout: check history length, completed weekly history, ATR and data quality. No provider requests were made.',
  };
}
export function health(store: Store, now: number, mode: string) {
  const queue = store.queueStatus(now);
  const last = store.get('last_scan', 0);
  return {
    mode,
    paused: store.settings().paused,
    budgetPaused: store.get('budget_paused', false),
    monitoring: last
      ? `${Math.max(0, Math.round((now - last) / 60000))} minutes since last scan`
      : 'Waiting for initial scan',
    publicationBlockers:
      mode === 'production'
        ? [
            ...new Set([
              ...productionBlockers(store, now),
              ...store.get<string[]>('publication_blockers', []),
            ]),
          ]
        : ['Private test-channel routing'],
    queue: {
      pending: store.pendingCount(),
      oldestVisibleMinutes: queue[0]?.ageMinutes ?? 0,
      reviewRequired: queue.filter((q) => q.reviewRequired).length,
      deliveries: queue,
    },
    lastError: store.get('last_error', null),
    providerUsage: store.get('provider_usage', {}),
    providerWork: store.get('provider_work', null),
    monitorJob: store.get('monitor_job', null),
    discoveryJob: store.get('discovery_job', null),
    lastDelivery: store.get('last_delivery', null),
    instruments: store.monitored().map((i) => ({
      symbol: i.symbol,
      quality: store.get(`quality:${i.id}`, null),
      asOf: store.get(`freshness:${i.id}`, null),
      refreshError: store.get(`refresh_error:${i.id}:15m`, null),
    })),
    cooldowns: {
      coinbase: store.get('retry_after:api.exchange.coinbase.com', 0),
      alpaca: store.get('retry_after:data.alpaca.markets', 0),
    },
  };
}

export interface FollowPreference {
  symbol: string;
  type: 'all' | 'entries' | 'setups' | 'updates' | 'trackers';
}
export function preferences(store: Store, user: string): FollowPreference[] {
  return store.get(`follow:${user}`, []);
}
export function follow(
  store: Store,
  user: string,
  symbol: string,
  type: FollowPreference['type'],
  remove = false,
) {
  const current = preferences(store, user);
  symbol = symbol.trim().toUpperCase();
  if (
    !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(symbol) ||
    !['all', 'entries', 'setups', 'updates', 'trackers'].includes(type)
  )
    throw new Error('Invalid follow preference');
  if (!remove && !store.monitored().some((i) => i.symbol === symbol))
    throw new Error('Follow a monitored symbol. Personal preferences do not add shared symbols.');
  const next = current.filter((p) => p.symbol !== symbol);
  if (!remove) next.push({ symbol, type });
  if (next.length > 25) throw new Error('Personal follows are limited to 25 symbols');
  store.set(`follow:${user}`, next);
  return next;
}
export function activeIdeas(store: Store, now: number) {
  return store.activeIdeas().map((idea) => {
    const c = idea.candidate;
    const config = store.version(c.strategyVersion);
    const origin = c.confirmedAt ?? c.retest?.end ?? c.breakout.end;
    const total =
      c.entry !== undefined
        ? config.exitSessions
        : c.retest
          ? config.confirmationSessions
          : config.retestBars;
    const sessions = store.get<{ rows: Dataset['sessions'] }>('calendar', { rows: [] }).rows;
    const elapsed = sessionsAfter(origin, now, c.instrument.market, sessions);
    const closes =
      c.instrument.market === 'crypto' ? undefined : sessions.filter((s) => s.open >= origin);
    const deadline =
      c.instrument.market === 'crypto'
        ? Math.floor(origin / DAY) * DAY + total * DAY
        : closes?.[total - 1]?.close;
    return {
      id: c.id,
      symbol: c.instrument.symbol,
      market: c.instrument.market,
      direction: c.direction,
      state: idea.state,
      version: c.strategyVersion,
      entry: c.entry,
      level: c.level,
      targets: c.targets,
      remainingSessions: Math.max(0, total - elapsed),
      deadline: deadline ? new Date(deadline).toISOString() : 'Calendar coverage unavailable',
      quality: store.get(`quality:${c.instrument.id}`, null),
    };
  });
}
export function digest(store: Store, now: number, user?: string) {
  const prefs = user ? preferences(store, user) : undefined;
  const events = store.db
    .prepare(
      "SELECT body FROM events WHERE json_extract(body,'$.marketTime')>=? ORDER BY seq DESC LIMIT 200",
    )
    .all(now - DAY) as { body: string }[];
  const matches = (e: SignalEvent, p: FollowPreference) =>
    e.instrument.symbol === p.symbol &&
    (p.type === 'all' ||
      (p.type === 'trackers' && e.kind === 'watch_tracker') ||
      (p.type === 'entries' && e.state === 'entry_triggered') ||
      (p.type === 'setups' &&
        ['watching', 'setup_ready'].includes(e.state) &&
        e.strategyVersion.startsWith('br-v1-')) ||
      (p.type === 'updates' && !['watching', 'setup_ready', 'entry_triggered'].includes(e.state)));
  return {
    asOf: new Date(now).toISOString(),
    window: 'Last 24 hours; at most 200 recent journal events',
    personal: !!user,
    preferences: prefs,
    active: activeIdeas(store, now).filter(
      (i) => !prefs || prefs.some((p) => p.symbol === i.symbol),
    ),
    changes: events
      .map((r) => JSON.parse(r.body) as SignalEvent)
      .filter((e) => !prefs || prefs.some((p) => matches(e, p)))
      .slice(0, 50)
      .map((e) => ({
        id: e.id,
        symbol: e.instrument.symbol,
        state: e.state,
        tracker: e.tracker?.type,
        at: new Date(e.marketTime).toISOString(),
        recovery: !!e.recovery,
        reasons: e.reasons,
      })),
    note: 'Cached signal references, not fills. Personal follows filter this digest; they do not change shared monitoring or send DMs.',
  };
}
export function statistics(store: Store) {
  // One terminal lifecycle per idea, rather than counting each target card as a trade.
  const rows = store.db
    .prepare(
      `WITH terminal AS (
    SELECT idea_id,MAX(seq) AS seq FROM events WHERE json_extract(body,'$.kind')='lifecycle'
    AND json_extract(body,'$.state') IN ('final_target','invalidated','expired','time_exit') GROUP BY idea_id
  ) SELECT json_extract(e.body,'$.strategyVersion') AS version,json_extract(e.body,'$.instrument.market') AS market,
    json_extract(e.body,'$.direction') AS direction,COALESCE(json_extract(e.body,'$.learning.benchmarkTrend'),'unknown') AS regime,
    count(*) AS samples,sum(CASE WHEN json_extract(e.body,'$.candidate.entry') IS NOT NULL THEN 1 ELSE 0 END) AS entered,
    sum(CASE WHEN json_extract(e.body,'$.state')='final_target' THEN 1 ELSE 0 END) AS finalTarget,
    sum(CASE WHEN json_extract(e.body,'$.state')='invalidated' THEN 1 ELSE 0 END) AS invalidated,
    sum(CASE WHEN json_extract(e.body,'$.state')='expired' THEN 1 ELSE 0 END) AS expired,
    sum(CASE WHEN json_extract(e.body,'$.state')='time_exit' THEN 1 ELSE 0 END) AS timeExit,
    sum(CASE WHEN json_extract(e.body,'$.performance.ambiguous')=1 THEN 1 ELSE 0 END) AS ambiguous,
    sum(CASE WHEN json_extract(e.body,'$.candidate.entry') IS NOT NULL AND json_extract(e.body,'$.performance.referencePrice') IS NULL THEN 1 ELSE 0 END) AS unknownPrice
    FROM terminal t JOIN events e ON e.seq=t.seq GROUP BY version,market,direction,regime`,
    )
    .all();
  return {
    groups: rows,
    note: 'Terminal idea counts by version, market, direction and benchmark regime. Target touches and reference-price outcomes are not fills or win probabilities. Ambiguous and unknown-price counts overlap outcome categories.',
  };
}
export function marketContext(store: Store, now: number, symbol?: string) {
  const ideas = store.activeIdeas();
  const instruments = store.monitored().filter((i) => !symbol || i.symbol === symbol);
  if (symbol && !instruments.length) throw new Error('Symbol is not monitored');
  return {
    asOf: new Date(now).toISOString(),
    instruments: instruments.map((i) => {
      const data = cachedDataset(store, i, now);
      const cutoff = now - data.provenance.delayMinutes * 60000;
      const quality = store.get(`quality:${i.id}`, null);
      let trend: string = 'unknown';
      try {
        checkDaily(benchmarkFor(i), data.benchmark, data.sessions, cutoff);
        trend = benchmarkTrend(data, cutoff);
      } catch {}
      return {
        symbol: i.symbol,
        benchmark: benchmarkFor(i).symbol,
        benchmarkTrend: trend,
        sector: i.sector ?? 'unknown',
        quality,
        relativeStrength: relativeStrength(
          data.daily.filter((b) => b.end <= cutoff),
          data.benchmark.filter((b) => b.end <= cutoff),
          store.strategy().rsPeriod,
        ),
      };
    }),
    concentration: (['equity', 'crypto'] as const).flatMap((m) =>
      (['bullish', 'bearish'] as const).map((d) => ({
        market: m,
        direction: d,
        ideas: ideas.filter(
          (i) => i.candidate.instrument.market === m && i.candidate.direction === d,
        ).length,
      })),
    ),
    sectors: [...new Set(ideas.map((i) => i.candidate.instrument.sector).filter(Boolean))].map(
      (sector) => ({
        sector,
        ideas: ideas.filter((i) => i.candidate.instrument.sector === sector).length,
      }),
    ),
    note: 'Concentration counts are not measured correlation. Missing sectors are not inferred. Context does not change signal rules.',
  };
}
