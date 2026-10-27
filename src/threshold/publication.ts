import type { Store } from '../sql-store.js';
import type { SignalEvent } from '../domain.js';
import { cachedDataset } from '../insights.js';
import { ThresholdStore } from './store.js';
import {
  expectedEnd,
  marketOpen,
  quoteProblem,
  returnMeasurement,
  returnQualifies,
} from './core.js';

/** Read-only, cached revalidation. Publication never launches market-data or chart work. */
export function thresholdPublishable(store: Store, event: SignalEvent, now: number): boolean {
  const a = event.threshold;
  if (!a || event.kind !== 'threshold_alert' || a.expiresAt <= now) return false;
  const state = new ThresholdStore(store),
    config = state.config(),
    settings = store.settings(),
    m = state.get(a.monitorId);
  if (
    !m ||
    m.status !== 'active' ||
    m.needsReset ||
    m.pendingId !== event.id ||
    m.episode !== a.episode ||
    m.allowance !== a.allowance ||
    m.revision !== a.revision ||
    m.deliveredAllowance === a.allowance ||
    !config.enabled ||
    !(m.mode === 'idea' ? config.ideas : config.contracts) ||
    !settings.alerts ||
    settings.paused ||
    store.get('budget_paused', false)
  )
    return false;
  const o = m.observation;
  if (
    !o?.eligible ||
    now - o.evaluatedAt > 10 * 60000 ||
    o.evaluatedAt > now ||
    o.marketTime !== a.observation.marketTime
  )
    return false;
  const data = cachedDataset(store, m.instrument, now),
    cutoff = now - (m.instrument.market === 'equity' ? 16 * 60000 : 0);
  if (
    !marketOpen(data, now) ||
    expectedEnd(data, cutoff) !== o.marketTime ||
    store.get(`history_changed:${m.instrument.id}`, false) ||
    store.get(`quality:${m.instrument.id}`, null) !== null
  )
    return false;
  if (m.mode === 'idea') {
    const idea = m.ideaId && store.idea(m.ideaId);
    if (!idea || !['entry_triggered', 'target_1', 'target_2'].includes(idea.state)) return false;
  } else {
    const expiry = data.sessions.find((s) => s.date === m.expiry);
    if (
      !m.expiry ||
      new Date(now).toISOString().slice(0, 10) > m.expiry ||
      (expiry && now >= expiry.close) ||
      quoteProblem(o.quote, m.contract!, m.quantity, now) ||
      quoteProblem(a.observation.quote, m.contract!, m.quantity, now)
    )
      return false;
  }
  return (
    returnQualifies(m, returnMeasurement(m, o.close, o.quote), o.quote) &&
    returnQualifies(
      m,
      returnMeasurement(m, a.observation.close, a.observation.quote),
      a.observation.quote,
    )
  );
}
