import type { Candidate, Dataset, Idea, Instrument, SignalEvent } from './domain.js';
import { terminalStates } from './domain.js';
import type { Store } from './sql-store.js';
import { DataService } from './data.js';
import { advance, detect, makeEvent, rank, stableId, pivotLevels } from './core/strategy.js';
import { atr, mean } from './core/indicators.js';
import { checkIntraday } from './core/quality.js';
import { DAY, QUARTER, utcDate } from './core/time.js';
import { diagnosticCode } from './core/errors.js';
export class SignalService {
  running = false;
  constructor(
    readonly store: Store,
    readonly data: DataService,
  ) {}
  async scan(now: number, force = false): Promise<void> {
    if (this.running || this.store.settings().paused || this.store.get('budget_paused', false))
      return;
    this.running = true;
    const previous = this.store.get('last_scan', 0),
      recovery = !previous || now - previous > 10 * 60_000;
    const progress = (stage: string) => this.store.set('scan_progress', { stage, at: Date.now() });
    try {
      progress('discovery');
      const newDay = this.store.get('discovery_day', '') !== utcDate(now),
        pool = newDay || force ? await this.data.universe(now) : [];
      progress('daily_history');
      await this.data.refreshDaily([...pool, ...this.store.monitored()], now, force);
      const config = this.store.strategy(),
        candidates: Candidate[] = [];
      for (const i of pool) {
        try {
          const data = await this.data.dataset(i, now);
          candidates.push(...detect(data, config, now));
          this.store.set(`quality:${i.id}`, null);
        } catch (e) {
          this.quality(i, e);
        }
      }
      if (pool.length) {
        this.store.selectAuto(rank(candidates).map((c) => c.instrument));
        this.store.set('discovery_day', utcDate(now));
      }
      const instruments = this.store.monitored();
      await this.data.refreshDaily(
        instruments.filter((i) => !pool.some((p) => p.id === i.id)),
        now,
        force,
      );
      progress('intraday_history');
      await this.data.refreshIntraday(instruments, now);
      progress('strategy_evaluation');
      let recovered = 0;
      for (const i of instruments) {
        try {
          const dataset = await this.data.dataset(i, now),
            cutoff = now - (i.market === 'equity' ? 16 * 60_000 : 0);
          checkIntraday(dataset, cutoff - 2 * QUARTER, cutoff);
          const existing = this.store
            .activeIdeas()
            .filter((x) => x.candidate.instrument.id === i.id);
          // At most one pending idea per direction per instrument, using the newest qualifying breakout.
          const detected = detect(dataset, config, cutoff).sort(
            (a, b) => b.breakout.end - a.breakout.end,
          );
          for (const c of detected) {
            if (this.store.activeIdeas().length >= 20) break;
            if (
              this.store.idea(c.id) ||
              existing.some((x) => x.candidate.direction === c.direction)
            )
              continue;
            checkIntraday(dataset, c.breakout.end, cutoff);
            const idea: Idea = {
              candidate: c,
              state: 'watching',
              lastBar: c.breakout.end,
              milestones: [],
              createdAt: now,
            };
            const event = makeEvent(idea, 'watching', c.breakout.end, dataset, now, c.reasons);
            event.recovery = recovery || now - event.marketTime > DAY;
            this.store.saveIdea(idea, [event]);
            existing.push(idea);
          }
          for (const idea of existing) {
            const from = idea.lastBar || idea.candidate.breakout.end;
            checkIntraday(dataset, from, cutoff);
            // Newly detected retests are copied into the existing frozen candidate; levels never change.
            const fresh = detected.find((c) => c.id === idea.candidate.id);
            if (!idea.candidate.retest && fresh?.retest) idea.candidate.retest = fresh.retest;
            const result = advance(
              idea,
              dataset,
              this.store.version(idea.candidate.strategyVersion),
              cutoff,
              this.store.activeEntries() < 20 || idea.candidate.entry !== undefined,
            );
            for (const event of result.events) {
              event.recordedAt = now;
              event.recovery = recovery || event.marketTime < cutoff - 2 * QUARTER;
              if (event.recovery) recovered++;
            }
            this.store.saveIdea(result.idea, result.events);
          }
          if (this.store.settings().alerts && !recovery) this.alerts(dataset, now);
          this.store.set(`quality:${i.id}`, null);
          this.store.set(
            `freshness:${i.id}`,
            dataset.intraday.at(-1)?.end ?? dataset.daily.at(-1)!.end,
          );
        } catch (e) {
          this.quality(i, e);
          if (e instanceof Error && e.message === 'HISTORY_REVISED_REFRESH_REQUIRED') {
            for (const old of this.store
              .activeIdeas()
              .filter((x) => x.candidate.instrument.id === i.id)) {
              old.state = 'expired';
              const history = this.store.journal(old.candidate.id).at(-1);
              if (history) {
                const event: SignalEvent = {
                  ...history,
                  id: stableId(old.candidate.id, 'history-revised', now),
                  state: 'expired',
                  recordedAt: now,
                  marketTime: now,
                  reasons: ['Historical bars revised; original levels require a new setup'],
                  candidate: old.candidate,
                };
                this.store.saveIdea(old, [event]);
              }
            }
            this.notice(
              now,
              `${i.symbol}: history revised; monitoring suspended and affected ideas expired.`,
              'operations',
            );
          }
        }
      }
      if (recovery)
        this.notice(
          now,
          `Recovery replay completed; ${recovered} lifecycle events recorded. Historical entry triggers were not published.`,
          'summaries',
        );
      if (newDay) {
        this.notice(
          now,
          `Daily discovery: ${pool.length} liquid instruments scanned; ${this.store.watchRows().filter((x) => x.auto).length} auto-selected; ${this.store.activeEntries()} active signal ideas.`,
          'summaries',
        );
        this.store.prune(now);
      }
      this.store.set('last_scan', now);
      const failed = instruments.filter((i) => this.store.get(`quality:${i.id}`, null) !== null);
      if (!failed.length && instruments.length) this.health(now);
      else this.store.set('soak_start', 0);
      progress('complete');
    } catch (error) {
      const stage = this.store.get<{ stage: string }>('scan_progress', { stage: 'unknown' }).stage;
      this.store.set('last_error_stage', stage);
      this.store.set('last_error', diagnosticCode(error));
      progress('failed');
      throw error;
    } finally {
      this.running = false;
    }
  }
  private quality(i: Instrument, e: unknown) {
    const code = e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'DATA_UNAVAILABLE';
    this.store.set(`quality:${i.id}`, code);
  }
  private health(now: number) {
    const last = this.store.get('healthy_at', 0);
    if (!last || now - last > 10 * 60_000) this.store.set('soak_start', now);
    this.store.set('healthy_at', now);
  }
  notice(now: number, text: string, route: 'summaries' | 'operations') {
    const c: Candidate = {
      id: stableId(route, utcDate(now)),
      instrument: { id: 'system', symbol: 'BOT', market: 'equity', venue: 'Discord' },
      direction: 'bullish',
      strategyVersion: 'system',
      breakout: { start: now, end: now, open: 1, high: 1, low: 1, close: 1, volume: 0 },
      level: 0,
      baseHigh: 0,
      baseLow: 0,
      atr: 0,
      relativeStrength: 0,
      relativeVolume: 0,
      provisionalRR: 0,
      reasons: [text],
    };
    const event: SignalEvent = {
      id: stableId(c.id, text),
      ideaId: c.id,
      instrument: c.instrument,
      direction: c.direction,
      state: 'watching',
      marketTime: now,
      recordedAt: now,
      strategyVersion: 'system',
      reasons: [text],
      candidate: c,
      provenance: { provider: 'Bot', feed: 'Operational', delayMinutes: 0, asOf: now },
    };
    this.store.enqueue(event, route);
  }
  private alerts(data: Dataset, now: number) {
    const b = data.daily.at(-1)!,
      prior = data.daily.slice(0, -1),
      a = atr(prior, this.store.strategy().atrPeriod),
      previous = prior.at(-1)!;
    const tests: [string, boolean][] = [
      ['unusual_volume', b.volume >= 2 * mean(prior.slice(-20).map((x) => x.volume))],
      ['large_daily_move', Math.abs(b.close - previous.close) >= 2 * a],
    ];
    const recent = data.intraday.filter(
        (b) => b.end > now - (data.instrument.market === 'equity' ? 16 * 60_000 : 0) - 3 * QUARTER,
      ),
      last = recent.at(-1),
      prev = recent.at(-2);
    if (last && prev) {
      for (const [direction, kind] of [
        ['bullish', 'resistance_cross'],
        ['bearish', 'support_cross'],
      ] as const) {
        const levels = pivotLevels(
          data.daily.filter((b) => b.end <= prev.start),
          direction,
          252,
        );
        tests.push([kind, levels.some((level) => (last.close - level) * (prev.close - level) < 0)]);
      }
    }
    for (const idea of this.store
      .activeIdeas()
      .filter((i) => i.candidate.instrument.id === data.instrument.id)) {
      const intraday = data.intraday.filter(
          (b) =>
            b.end > now - (data.instrument.market === 'equity' ? 16 * 60_000 : 0) - 2 * QUARTER,
        ),
        last = intraday.at(-1),
        prev = intraday.at(-2);
      if (last && prev)
        tests.push([
          `level_cross_${idea.candidate.id}`,
          (last.close - idea.candidate.level) * (prev.close - idea.candidate.level) < 0,
        ]);
    }
    for (const [kind, trigger] of tests) {
      const bar = kind.startsWith('level') || kind.endsWith('_cross') ? data.intraday.at(-1)! : b;
      if (!trigger || !this.store.cooldown(`${data.instrument.id}:${kind}`, bar.end)) continue;
      const c: Candidate = {
        id: stableId(data.instrument.id, kind),
        instrument: data.instrument,
        direction: b.close >= previous.close ? 'bullish' : 'bearish',
        strategyVersion: 'watch-alert-v1',
        breakout: b,
        level: previous.close,
        baseHigh: b.high,
        baseLow: b.low,
        atr: a,
        relativeStrength: 0,
        relativeVolume: 0,
        provisionalRR: 0,
        reasons: [kind.replaceAll('_', ' ')],
      };
      this.store.enqueue(
        {
          id: stableId(c.id, bar.end),
          ideaId: c.id,
          instrument: data.instrument,
          direction: c.direction,
          state: 'watching',
          marketTime: bar.end,
          recordedAt: now,
          strategyVersion: c.strategyVersion,
          reasons: c.reasons,
          candidate: c,
          provenance: { ...data.provenance, asOf: bar.end },
        },
        'watchlist',
      );
    }
  }
}
