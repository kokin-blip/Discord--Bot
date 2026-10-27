import type { Dataset, SignalEvent } from '../domain.js';
import type { SqlDatabase, Store } from '../sql-store.js';
import { stableId } from '../core/strategy.js';
import { atr } from '../core/indicators.js';
import { thresholdSchema, thresholdDefaults, parseContract } from './core.js';
import type { ThresholdConfig, ThresholdMonitor, ThresholdReview } from './types.js';

export function initializeThresholdSchema(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threshold_monitors(id TEXT PRIMARY KEY,mode TEXT NOT NULL,owner TEXT,contract TEXT,status TEXT NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS threshold_active ON threshold_monitors(status,mode,owner);
    CREATE UNIQUE INDEX IF NOT EXISTS threshold_owner_contract ON threshold_monitors(owner,contract) WHERE mode='contract' AND status IN ('active','suspended');
    CREATE TABLE IF NOT EXISTS threshold_rules(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS threshold_rules_no_update BEFORE UPDATE ON threshold_rules BEGIN SELECT RAISE(ABORT,'Threshold rules are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS threshold_rules_no_delete BEFORE DELETE ON threshold_rules BEGIN SELECT RAISE(ABORT,'Threshold rules are immutable'); END;
    CREATE TABLE IF NOT EXISTS threshold_reviews(event_id TEXT PRIMARY KEY,monitor_id TEXT NOT NULL,delivered_at INTEGER NOT NULL,done INTEGER NOT NULL DEFAULT 0,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS threshold_reviews_pending ON threshold_reviews(done,delivered_at);
    CREATE TABLE IF NOT EXISTS threshold_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,monitor_id TEXT,at INTEGER NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS threshold_audit_no_update BEFORE UPDATE ON threshold_audit BEGIN SELECT RAISE(ABORT,'Threshold audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS threshold_audit_no_delete BEFORE DELETE ON threshold_audit BEGIN SELECT RAISE(ABORT,'Threshold audit is append-only'); END;
  `);
}
export class ThresholdStore {
  constructor(readonly store: Store) {}
  config(): ThresholdConfig {
    return thresholdSchema.parse(this.store.get('threshold_config', thresholdDefaults));
  }
  revision(config = this.config()): string {
    const { hours, progressAtr, contractLossPercent, ideaLossR } = config;
    const rules = { hours, progressAtr, contractLossPercent, ideaLossR };
    const id = `threshold-v1-${stableId(JSON.stringify(rules))}`;
    this.store.db
      .prepare('INSERT OR IGNORE INTO threshold_rules VALUES(?,?)')
      .run(id, JSON.stringify(rules));
    return id;
  }
  all(includeEnded = false): ThresholdMonitor[] {
    return (
      this.store.db
        .prepare(
          includeEnded
            ? 'SELECT body FROM threshold_monitors ORDER BY id'
            : "SELECT body FROM threshold_monitors WHERE status IN ('active','suspended') ORDER BY id",
        )
        .all() as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  get(id: string): ThresholdMonitor | undefined {
    const row = this.store.db.prepare('SELECT body FROM threshold_monitors WHERE id=?').get(id) as
      { body: string } | undefined;
    return row && JSON.parse(row.body);
  }
  save(m: ThresholdMonitor): void {
    this.store.db
      .prepare(
        'INSERT INTO threshold_monitors VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body',
      )
      .run(m.id, m.mode, m.owner ?? null, m.contract ?? null, m.status, JSON.stringify(m));
  }
  audit(action: string, actor: string, now: number, body: unknown, id?: string): void {
    this.store.db
      .prepare('INSERT INTO threshold_audit(monitor_id,at,action,actor,body) VALUES(?,?,?,?,?)')
      .run(id ?? null, now, action, actor, JSON.stringify(body));
  }
  suppress(event: SignalEvent): void {
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE outbox SET status='suppressed',last_error='THRESHOLD_OBSOLETE' WHERE event_id=? AND status IN ('pending','dead')",
        )
        .run(event.id);
      const m = event.threshold && this.get(event.threshold.monitorId);
      if (m?.pendingId === event.id) {
        delete m.pendingId;
        this.save(m);
      }
    });
  }
  invalidate(m: ThresholdMonitor): void {
    if (m.pendingId) {
      this.store.db
        .prepare(
          "UPDATE outbox SET status='suppressed',last_error='THRESHOLD_OBSOLETE' WHERE event_id=? AND status IN ('pending','dead')",
        )
        .run(m.pendingId);
      delete m.pendingId;
    }
  }
  reconcilePending(m: ThresholdMonitor, now: number): void {
    if (!m.pendingId) return;
    const row = this.store.db
      .prepare(
        `SELECT o.status,e.body,
      (SELECT message_id FROM delivery_receipts r WHERE r.event_id=o.event_id LIMIT 1) AS receipt
      FROM outbox o JOIN events e ON e.id=o.event_id WHERE o.event_id=?`,
      )
      .get(m.pendingId) as { status: string; body: string; receipt?: string } | undefined;
    const event = row && (JSON.parse(row.body) as SignalEvent | undefined);
    if (row?.receipt && event) {
      this.delivered(event, now);
      this.store.delivered(event.id);
      Object.assign(m, this.get(m.id)!);
      delete m.pendingId;
    } else if (
      !row ||
      row.status !== 'pending' ||
      !event?.threshold ||
      event.threshold.expiresAt <= now
    ) {
      this.invalidate(m);
    }
  }
  requestReset(m: ThresholdMonitor): void {
    this.invalidate(m);
    m.needsReset = true;
    if (m.observation) {
      m.observation.eligible = false;
      m.observation.reason = 'FRESH_OBSERVATION_WINDOW_REQUIRED';
    }
    this.save(m);
  }
  configure(patch: Partial<ThresholdConfig>, actor: string, now: number): ThresholdConfig {
    const old = this.config(),
      next = thresholdSchema.parse({ ...old, ...patch });
    if (JSON.stringify(old) === JSON.stringify(next)) return old;
    this.store.transaction(() => {
      this.revision(next);
      this.store.set('threshold_config', next);
      for (const m of this.all()) if (m.status === 'active') this.requestReset(m);
      this.audit('config', actor, now, next);
    });
    return next;
  }
  register(
    input: {
      contract: string;
      entry: number;
      quantity?: number;
      stop?: number;
      fees?: number;
      ideaId?: string;
    },
    owner: string,
    now: number,
  ): ThresholdMonitor {
    const parsed = parseContract(input.contract);
    const instrument = this.store
      .baseMonitored()
      .find((i) => i.market === 'equity' && i.symbol === parsed.symbol);
    if (!instrument)
      throw new Error(
        'The underlying must already be selected or monitored for an active equity/ETF idea.',
      );
    if (parsed.expiry < new Date(now).toISOString().slice(0, 10))
      throw new Error('Contract is expired.');
    const sessions = this.store.get<{ rows: Dataset['sessions'] }>('calendar', { rows: [] }).rows;
    const expirySession = sessions.find((s) => s.date === parsed.expiry);
    if (expirySession && now >= expirySession.close) throw new Error('Contract is expired.');
    if (input.ideaId) {
      const idea = this.store.idea(input.ideaId);
      if (
        !idea ||
        idea.candidate.instrument.id !== instrument.id ||
        idea.candidate.direction !== parsed.direction
      )
        throw new Error('Linked idea must match the underlying and call/put direction.');
    }
    const config = this.config();
    const m: ThresholdMonitor = {
      id: stableId('threshold-contract', owner, parsed.contract, now),
      mode: 'contract',
      owner,
      ideaId: input.ideaId,
      instrument,
      direction: parsed.direction,
      status: 'active',
      contract: parsed.contract,
      expiry: parsed.expiry,
      entry: input.entry,
      quantity: input.quantity ?? 1,
      stop: input.stop,
      fees: input.fees,
      createdAt: now,
      startedAt: now,
      lastEvaluated: 0,
      lastBar: 0,
      checkpoint: 0,
      frozenAtr: 0,
      progressAt: now,
      revision: '',
      rules: config,
      needsReset: true,
      episode: 0,
      allowance: 0,
      deliveredAllowance: -1,
      attempt: 0,
    };
    validatePosition(m);
    this.store.transaction(() => {
      const existing = this.all().filter((x) => x.mode === 'contract');
      if (existing.some((x) => x.owner === owner && x.contract === m.contract))
        throw new Error('Already tracking this contract; use /threshold edit.');
      if (existing.length >= 20 || existing.filter((x) => x.owner === owner).length >= 5)
        throw new Error('Registered monitor limit: five per member and twenty server-wide.');
      const sequence = this.store.get('threshold_registration_sequence', 0) + 1;
      this.store.set('threshold_registration_sequence', sequence);
      m.id = stableId('threshold-contract', owner, parsed.contract, now, sequence);
      m.revision = this.revision(config);
      this.save(m);
      this.audit('add', owner, now, m, m.id);
    });
    return m;
  }
  manage(id: string, actor: string, manager: boolean): ThresholdMonitor {
    const m = this.get(id);
    if (!m) throw new Error('Unknown threshold monitor ID.');
    if (!manager && (m.mode === 'idea' || m.owner !== actor))
      throw new Error('Only the owner or a manager can change this monitor.');
    return m;
  }
  edit(
    id: string,
    patch: { entry?: number; quantity?: number; stop?: number | null; fees?: number },
    actor: string,
    manager: boolean,
    now: number,
  ): ThresholdMonitor {
    const m = this.manage(id, actor, manager);
    if (m.mode !== 'contract' || ['stopped', 'expired'].includes(m.status))
      throw new Error('Edit an active or suspended registered contract.');
    const before = JSON.stringify([m.entry, m.quantity, m.stop, m.fees]);
    if (patch.entry !== undefined) m.entry = patch.entry;
    if (patch.quantity !== undefined) m.quantity = patch.quantity;
    if (patch.fees !== undefined) m.fees = patch.fees;
    if (patch.stop === null) delete m.stop;
    else if (patch.stop !== undefined) m.stop = patch.stop;
    validatePosition(m);
    if (
      before === JSON.stringify([m.entry, m.quantity, m.stop, m.fees]) &&
      m.status !== 'suspended'
    )
      return m;
    this.store.transaction(() => {
      m.status = 'active';
      m.startedAt = now;
      delete m.peakPercent;
      delete m.observation;
      this.requestReset(m);
      this.audit('edit', actor, now, patch, id);
    });
    return m;
  }
  stop(id: string, actor: string, manager: boolean, now: number): void {
    const m = this.manage(id, actor, manager);
    if (m.status === 'stopped' || m.status === 'expired') return;
    this.store.transaction(() => {
      this.invalidate(m);
      m.status = 'stopped';
      this.save(m);
      this.audit('stop_monitoring', actor, now, {}, id);
    });
  }
  snooze(id: string, actor: string, manager: boolean, now: number): void {
    const m = this.manage(id, actor, manager);
    if (m.status !== 'active' || !m.observation || m.deliveredAllowance < 0)
      throw new Error('Snooze an active monitor after its first delivered alert.');
    this.store.transaction(() => {
      this.invalidate(m);
      m.allowance++;
      m.snoozedAt = now;
      this.save(m);
      this.audit('snooze', actor, now, { allowance: m.allowance }, id);
    });
  }
  delivered(event: SignalEvent, now: number): void {
    const a = event.threshold;
    if (!a) return;
    const m = this.get(a.monitorId);
    if (m && m.episode === a.episode && m.allowance === a.allowance && m.revision === a.revision) {
      m.deliveredAllowance = a.allowance;
      if (m.pendingId === event.id) delete m.pendingId;
      this.save(m);
    }
    const review: ThresholdReview = {
      eventId: event.id,
      monitorId: a.monitorId,
      alert: a,
      deliveredAt: now,
    };
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO threshold_reviews(event_id,monitor_id,delivered_at,body) VALUES(?,?,?,?)',
      )
      .run(event.id, a.monitorId, now, JSON.stringify(review));
  }
  reviews(id?: string): ThresholdReview[] {
    const rows = (
      id
        ? this.store.db
            .prepare(
              'SELECT body FROM threshold_reviews WHERE monitor_id=? ORDER BY delivered_at DESC LIMIT 20',
            )
            .all(id)
        : this.store.db
            .prepare(
              'SELECT body FROM threshold_reviews WHERE done=0 ORDER BY delivered_at LIMIT 40',
            )
            .all()
    ) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body));
  }
  saveReview(review: ThresholdReview): void {
    this.store.db
      .prepare('UPDATE threshold_reviews SET body=?,done=? WHERE event_id=?')
      .run(JSON.stringify(review), review.oneHour && review.fourHours ? 1 : 0, review.eventId);
  }
  status() {
    const monitors = this.all();
    return {
      config: this.config(),
      active: monitors.filter((m) => m.status === 'active').length,
      suspended: monitors.filter((m) => m.status === 'suspended').length,
      ideas: monitors.filter((m) => m.mode === 'idea').length,
      contracts: monitors.filter((m) => m.mode === 'contract').length,
      lastPoll: this.store.get('threshold_last_poll', null),
      error: this.store.get('threshold_error', null),
      deferred: this.store.get('threshold_deferred', null),
      monitors: monitors.map((m) => ({
        id: m.id,
        symbol: m.instrument.symbol,
        owner: m.owner,
        status: m.status,
        lastEvaluation: m.lastEvaluated,
        quoteTime: m.observation?.quote?.asOf,
        reason: m.observation?.reason,
      })),
    };
  }
}
export function validatePosition(
  m: Pick<ThresholdMonitor, 'entry' | 'quantity' | 'stop' | 'fees'>,
): void {
  if (
    !Number.isFinite(m.entry * 100 * m.quantity) ||
    !Number.isFinite(m.entry) ||
    m.entry <= 0 ||
    !Number.isInteger(m.quantity) ||
    m.quantity < 1 ||
    m.quantity > 1000 ||
    (m.fees !== undefined && (!Number.isFinite(m.fees) || m.fees < 0 || m.fees > 10000)) ||
    (m.stop !== undefined && (!Number.isFinite(m.stop) || m.stop <= 0 || m.stop >= m.entry))
  )
    throw new Error(
      'Use positive entry premium, quantity 1–1000, nonnegative fees, and a positive stop below entry.',
    );
}
export function resetBaseline(
  m: ThresholdMonitor,
  data: Dataset,
  now: number,
  period: number,
  revision: string,
  rules: ThresholdConfig,
): boolean {
  const cutoff = now - (m.instrument.market === 'equity' ? 16 * 60000 : 0);
  const bar = data.intraday.filter((b) => b.end <= cutoff).at(-1);
  const value = atr(
    data.daily.filter((b) => b.end <= now),
    period,
  );
  if (!bar || !Number.isFinite(value) || value <= 0) return false;
  m.frozenAtr = value;
  m.lastBar = bar.end;
  m.checkpoint = bar.close;
  m.startedAt = now;
  m.progressAt = now;
  m.lastEvaluated = now;
  m.episode++;
  m.allowance = 0;
  m.deliveredAllowance = -1;
  delete m.snoozedAt;
  m.needsReset = false;
  m.rules = { ...rules };
  m.revision = revision;
  return true;
}
