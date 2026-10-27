import type { Dataset, Idea, SignalEvent } from '../domain.js';
import { terminalStates } from '../domain.js';
import type { Store } from '../sql-store.js';
import type { DataService } from '../data.js';
import { checkIntraday } from '../core/quality.js';
import { completed, utcDate } from '../core/time.js';
import { atr } from '../core/indicators.js';
import { stableId } from '../core/strategy.js';
import { diagnosticCode } from '../core/errors.js';
import { ThresholdStore, resetBaseline } from './store.js';
import {
  HOUR,
  marketMilliseconds,
  marketOpen,
  expectedEnd,
  quoteProblem,
  returnMeasurement,
  returnQualifies,
  contractionRatio,
} from './core.js';
import type { OptionQuote, ThresholdMonitor, ThresholdObservation } from './types.js';

export class ThresholdEngine {
  readonly state: ThresholdStore;
  constructor(
    readonly store: Store,
    readonly data: DataService,
    readonly clock: () => number = Date.now,
  ) {
    this.state = new ThresholdStore(store);
  }
  async poll(
    datasets: Map<string, Dataset>,
    now: number,
    newEntries = new Set<string>(),
  ): Promise<void> {
    const pollStartedAt = this.clock();
    const config = this.state.config(),
      settings = this.store.settings();
    const enabled =
      config.enabled &&
      settings.alerts &&
      !settings.paused &&
      !this.store.get('budget_paused', false);
    if (enabled && config.ideas) {
      for (const idea of this.store.activeIdeas()) {
        const c = idea.candidate,
          id = stableId('threshold-idea', c.id);
        const data = datasets.get(c.instrument.id);
        if (c.entry === undefined || c.confirmedAt === undefined || this.state.get(id) || !data)
          continue;
        const m = this.seedIdea(idea, data, now, newEntries.has(c.id));
        this.store.transaction(() => this.state.save(m));
      }
    }
    const monitors = this.state.all();
    const symbols = [
      ...new Set(
        monitors
          .filter(
            (m) =>
              enabled &&
              config.contracts &&
              m.mode === 'contract' &&
              m.status === 'active' &&
              datasets.has(m.instrument.id) &&
              marketOpen(datasets.get(m.instrument.id)!, now) &&
              !this.expired(m, datasets.get(m.instrument.id)!, now),
          )
          .map((m) => m.contract!),
      ),
    ];
    let quotes: OptionQuote[] = [];
    this.store.set('threshold_deferred', null);
    if (symbols.length) {
      try {
        quotes = (await this.data.equities.optionQuotes?.(symbols, now)) ?? [];
        this.store.set('threshold_error', null);
        if (!this.data.equities.optionQuotes)
          this.store.set('threshold_error', 'OPTION_QUOTES_UNSUPPORTED');
      } catch (e) {
        const code = diagnosticCode(e);
        this.store.set('threshold_error', code);
        if (e instanceof Error && /WORK_LIMIT|RETRY_LATER|BUDGET/.test(e.message))
          this.store.set('threshold_deferred', code);
      }
    }
    // Keep a supplied logical clock deterministic, while accounting for real provider latency.
    now += Math.max(0, this.clock() - pollStartedAt);
    for (const snapshot of monitors) {
      this.store.transaction(() => {
        const m = this.state.get(snapshot.id);
        if (!m || !['active', 'suspended'].includes(m.status) || m.createdAt > now) return;
        this.state.reconcilePending(m, now);
        const data = datasets.get(m.instrument.id);
        const currentConfig = this.state.config(),
          currentSettings = this.store.settings();
        const currentlyEnabled =
          currentConfig.enabled &&
          currentSettings.alerts &&
          !currentSettings.paused &&
          !this.store.get('budget_paused', false);
        if (m.mode === 'idea') {
          const idea = m.ideaId && this.store.idea(m.ideaId);
          if (!idea || terminalStates.has(idea.state)) {
            this.state.invalidate(m);
            m.status = 'expired';
            this.ineligible(m, 'IDEA_TERMINAL', now);
            this.state.save(m);
            return;
          }
        }
        if (m.mode === 'contract' && this.expired(m, data, now)) {
          this.state.invalidate(m);
          m.status = 'expired';
          this.ineligible(m, 'CONTRACT_EXPIRED', now);
          this.state.save(m);
          return;
        }
        if (m.status !== 'active') return;
        if (
          !currentlyEnabled ||
          !(m.mode === 'idea' ? currentConfig.ideas : currentConfig.contracts)
        ) {
          if (!m.needsReset || m.pendingId) this.state.requestReset(m);
          return;
        }
        if (!data) {
          this.state.invalidate(m);
          m.needsReset = true;
          this.ineligible(m, 'UNDERLYING_DATA_UNAVAILABLE', now);
          this.state.save(m);
          return;
        }
        const q = quotes.find((q) => q.contract === m.contract);
        this.evaluate(m, data, q, now);
        if (m.observation?.eligible && m.deliveredAllowance !== m.allowance && !m.pendingId) {
          m.attempt++;
          const event = thresholdEvent(m, now);
          m.pendingId = event.id;
          this.state.save(m);
          this.store.enqueue(event, 'updates');
        } else this.state.save(m);
      });
    }
    this.review(datasets, now);
    this.store.set('threshold_last_poll', now);
  }
  private expired(m: ThresholdMonitor, data: Dataset | undefined, now: number): boolean {
    if (!m.expiry) return false;
    if (utcDate(now) > m.expiry) return true;
    const sessions =
      data?.sessions ??
      this.store.get<{ rows: Dataset['sessions'] }>('calendar', { rows: [] }).rows;
    const s = sessions.find((s) => s.date === m.expiry);
    return !!s && now >= s.close;
  }
  private seedIdea(idea: Idea, data: Dataset, now: number, fresh: boolean): ThresholdMonitor {
    const c = idea.candidate,
      config = this.state.config(),
      since = fresh ? c.confirmedAt! : now;
    const frozen = atr(
      data.daily.filter((b) => b.end <= since),
      this.store.version(c.strategyVersion).atrPeriod,
    );
    return {
      id: stableId('threshold-idea', c.id),
      mode: 'idea',
      ideaId: c.id,
      instrument: c.instrument,
      direction: c.direction,
      status: 'active',
      entry: c.entry!,
      risk: Math.abs(c.entry! - c.level),
      quantity: 1,
      createdAt: now,
      startedAt: since,
      lastEvaluated: now,
      lastBar: fresh ? c.confirmedAt! : 0,
      checkpoint: fresh ? c.entry! : 0,
      frozenAtr: frozen,
      progressAt: since,
      revision: this.state.revision(config),
      rules: config,
      needsReset: !fresh || !Number.isFinite(frozen) || frozen <= 0,
      episode: 0,
      allowance: 0,
      deliveredAllowance: -1,
      attempt: 0,
    };
  }
  private ineligible(m: ThresholdMonitor, reason: string, now: number): void {
    if (m.observation)
      m.observation = { ...m.observation, evaluatedAt: now, eligible: false, reason };
  }
  private evaluate(
    m: ThresholdMonitor,
    data: Dataset,
    q: OptionQuote | undefined,
    now: number,
  ): void {
    const config = this.state.config(),
      cutoff = now - (m.instrument.market === 'equity' ? 16 * 60000 : 0);
    const bar = completed(data.intraday, cutoff).at(-1);
    if (
      !bar ||
      bar.end !== expectedEnd(data, cutoff) ||
      this.store.get(`history_changed:${m.instrument.id}`, false)
    ) {
      this.state.invalidate(m);
      m.needsReset = true;
      this.ineligible(m, 'UNDERLYING_STALE_OR_REVISED', now);
      return;
    }
    if (m.lastEvaluated && now - m.lastEvaluated > 10 * 60000) m.needsReset = true;
    if (!m.needsReset) {
      try {
        checkIntraday(data, m.lastBar, cutoff);
      } catch {
        m.needsReset = true;
      }
    }
    if (m.needsReset) {
      this.state.invalidate(m);
      if (
        !resetBaseline(
          m,
          data,
          now,
          this.store.strategy().atrPeriod,
          this.state.revision(config),
          config,
        )
      ) {
        this.ineligible(m, 'ATR_OR_BASELINE_UNAVAILABLE', now);
        return;
      }
    } else {
      for (const b of completed(data.intraday, cutoff)) {
        if (b.end <= m.lastBar) continue;
        m.lastBar = b.end;
        if (b.end <= m.startedAt) continue;
        const advance = (m.direction === 'bullish' ? 1 : -1) * (b.close - m.checkpoint);
        if (advance + 1e-10 >= m.rules.progressAtr * m.frozenAtr) {
          this.state.invalidate(m);
          m.checkpoint = b.close;
          m.progressAt = b.end;
          m.episode++;
          m.allowance = 0;
          m.deliveredAllowance = -1;
          delete m.snoozedAt;
        }
      }
    }
    m.lastEvaluated = now;
    const quoteError =
      m.mode === 'contract' ? quoteProblem(q, m.contract!, m.quantity, now) : undefined;
    const value = quoteError ? undefined : returnMeasurement(m, bar.close, q);
    if (value && Number.isFinite(value.returnPercent))
      m.peakPercent = Math.max(m.peakPercent ?? -Infinity, value.returnPercent);
    const elapsed =
      marketMilliseconds(m.progressAt, bar.end, m.instrument.market, data.sessions) / HOUR;
    let reason = !marketOpen(data, now)
      ? 'MARKET_CLOSED'
      : (quoteError ??
        (elapsed + 1e-10 < m.rules.hours
          ? 'OBSERVING_PROGRESS_WINDOW'
          : !returnQualifies(m, value, q)
            ? 'OUTSIDE_RETURN_GATE'
            : 'THRESHOLD_REACHED'));
    if (m.mode === 'contract' && !quoteError && q && m.stop !== undefined && q.bid <= m.stop) {
      this.state.invalidate(m);
      m.status = 'suspended';
      reason = 'ENTERED_STOP_REFERENCE_REACHED';
    }
    if (
      reason === 'THRESHOLD_REACHED' &&
      m.snoozedAt !== undefined &&
      marketMilliseconds(m.snoozedAt, bar.end, m.instrument.market, data.sessions) < HOUR
    )
      reason = 'SNOOZED';
    const observation: ThresholdObservation = {
      evaluatedAt: now,
      marketTime: bar.end,
      close: bar.close,
      elapsedHours: Math.max(0, elapsed),
      eligible: reason === 'THRESHOLD_REACHED',
      reason,
      ...value,
      peakPercent: m.peakPercent,
      contractionRatio: contractionRatio(data, cutoff),
      quote: quoteError ? undefined : q,
      provenance: { ...data.provenance, asOf: bar.end },
    };
    m.observation = observation;
    if (!observation.eligible) this.state.invalidate(m);
  }
  private review(datasets: Map<string, Dataset>, now: number): void {
    for (const r of this.state.reviews()) {
      const m = this.state.get(r.monitorId),
        data = m && datasets.get(m.instrument.id),
        o = m?.observation;
      let changed = false;
      for (const [key, hours] of [
        ['oneHour', 1],
        ['fourHours', 4],
      ] as const) {
        if (r[key]) continue;
        const ended =
          !m ||
          m.status !== 'active' ||
          !this.state.config().enabled ||
          m.entry !== r.alert.monitor.entry ||
          m.quantity !== r.alert.monitor.quantity ||
          m.fees !== r.alert.monitor.fees;
        const sessions =
          data?.sessions ??
          this.store.get<{ rows: Dataset['sessions'] }>('calendar', { rows: [] }).rows;
        const market = r.alert.monitor.instrument.market;
        const elapsed = marketMilliseconds(r.deliveredAt, now, market, sessions);
        if (!ended && elapsed < hours * HOUR) continue;
        const observationTime = m?.mode === 'contract' ? o?.quote?.asOf : o?.marketTime;
        const observed =
          !ended &&
          !!data &&
          !!o &&
          o.evaluatedAt === now &&
          Number.isFinite(o.returnPercent) &&
          observationTime !== undefined &&
          marketMilliseconds(r.deliveredAt, observationTime, market, sessions) >= hours * HOUR;
        if (!ended && !observed && elapsed < (hours + 0.5) * HOUR) continue;
        r[key] = observed
          ? {
              at: observationTime!,
              returnPercent: o!.returnPercent,
              reason: 'OBSERVED_REFERENCE_NOT_REALIZED',
            }
          : { at: now, reason: ended ? 'MONITOR_ENDED_OR_DISABLED' : 'EVIDENCE_UNAVAILABLE' };
        changed = true;
      }
      if (changed) this.state.saveReview(r);
    }
  }
}
export function thresholdEvent(m: ThresholdMonitor, now: number): SignalEvent {
  const o = m.observation!;
  const id = stableId('threshold-alert', m.id, m.revision, m.episode, m.allowance, m.attempt);
  return {
    id,
    ideaId: `threshold:${m.id}`,
    kind: 'threshold_alert',
    instrument: m.instrument,
    direction: m.direction,
    state: 'watching',
    strategyVersion: m.revision,
    marketTime: o.marketTime,
    recordedAt: now,
    reasons: ['Stalled-trade exit review; no order or lifecycle change'],
    provenance: o.provenance,
    threshold: {
      monitorId: m.id,
      episode: m.episode,
      allowance: m.allowance,
      revision: m.revision,
      expiresAt: now + 10 * 60000,
      monitor: structuredClone(m),
      observation: structuredClone(o),
    },
    candidate: {
      id: `threshold:${m.id}`,
      instrument: m.instrument,
      direction: m.direction,
      strategyVersion: m.revision,
      breakout: {
        start: o.marketTime - 900000,
        end: o.marketTime,
        open: o.close,
        high: o.close,
        low: o.close,
        close: o.close,
        volume: 0,
      },
      level: 0,
      baseHigh: 0,
      baseLow: 0,
      atr: m.frozenAtr,
      relativeStrength: 0,
      relativeVolume: 0,
      provisionalRR: 0,
      reasons: [],
    },
  };
}
