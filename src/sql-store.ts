import type { Bar, Idea, Instrument, SignalEvent } from './domain.js';
import { terminalStates } from './domain.js';
import {
  initialSettings,
  type Route,
  type Settings,
  type StrategyConfig,
  defaults,
  strategySchema,
} from './config.js';
import { strategyVersion } from './core/strategy.js';
type Row = Record<string, string | number | null>;
export interface SqlDatabase {
  mode?: string;
  exec(sql: string): unknown;
  close(): void;
  transaction?<T>(fn: () => T): T;
  prepare(sql: string): {
    run(...params: (string | number | null)[]): { changes: number | bigint };
    get(...params: (string | number | null)[]): unknown;
    all(...params: (string | number | null)[]): unknown[];
  };
}
export class Store {
  private transactionDepth = 0;
  constructor(readonly db: SqlDatabase) {
    this.db.exec(`${this.db.mode === 'cloud' ? '' : 'PRAGMA foreign_keys=ON;'}
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watch(id TEXT PRIMARY KEY,instrument TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,auto INTEGER NOT NULL DEFAULT 0,excluded INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS candles(instrument TEXT NOT NULL,interval TEXT NOT NULL,start INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(instrument,interval,start));
      CREATE TABLE IF NOT EXISTS ideas(id TEXT PRIMARY KEY,body TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,idea_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Event journal is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Event journal is append-only'); END;
      CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY REFERENCES events(id),route TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT);
      CREATE TABLE IF NOT EXISTS threads(idea_id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,message_id TEXT NOT NULL,thread_id TEXT);
      CREATE TABLE IF NOT EXISTS delivery_receipts(event_id TEXT NOT NULL REFERENCES events(id),destination TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(event_id,destination));
      CREATE TABLE IF NOT EXISTS cooldowns(key TEXT PRIMARY KEY,time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS strategy_versions(version TEXT PRIMARY KEY,body TEXT NOT NULL);
      ${this.db.mode === 'cloud' ? '' : 'PRAGMA user_version=1;'} `);
    this.saveStrategy(this.strategy());
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.transactionDepth++;
    try {
      if (this.db.transaction) return this.db.transaction(fn);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    } finally {
      this.transactionDepth--;
    }
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as Row | undefined;
    return row ? (JSON.parse(String(row.value)) as T) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  settings(): Settings {
    return { ...structuredClone(initialSettings), ...this.get<Partial<Settings>>('settings', {}) };
  }
  strategy(): StrategyConfig {
    return strategySchema.parse(this.get('strategy', defaults));
  }
  saveStrategy(config: StrategyConfig) {
    const parsed = strategySchema.parse(config),
      changed = strategyVersion(this.strategy()) !== strategyVersion(parsed);
    this.transaction(() => {
      if (changed) {
        this.set('historical_replay_verified', false);
        this.set('soak_start', 0);
      }
      this.set('strategy', parsed);
      this.db
        .prepare('INSERT OR IGNORE INTO strategy_versions VALUES(?,?)')
        .run(strategyVersion(parsed), JSON.stringify(parsed));
    });
  }
  version(version: string): StrategyConfig {
    const row = this.db
      .prepare('SELECT body FROM strategy_versions WHERE version=?')
      .get(version) as Row | undefined;
    if (!row) throw new Error('Unknown strategy version');
    return strategySchema.parse(JSON.parse(String(row.body)));
  }
  watchRows(): { instrument: Instrument; pinned: boolean; auto: boolean; excluded: boolean }[] {
    return (this.db.prepare('SELECT * FROM watch ORDER BY id').all() as Row[]).map((r) => ({
      instrument: JSON.parse(String(r.instrument)),
      pinned: !!r.pinned,
      auto: !!r.auto,
      excluded: !!r.excluded,
    }));
  }
  pin(i: Instrument) {
    const current = this.watchRows();
    if (
      !current.find((r) => r.instrument.id === i.id)?.pinned &&
      current.filter((r) => r.pinned && !r.excluded).length >= 10
    )
      throw new Error('Manual watchlist is limited to 10 symbols');
    this.db
      .prepare(
        'INSERT INTO watch VALUES(?,?,1,0,0) ON CONFLICT(id) DO UPDATE SET pinned=1,excluded=0',
      )
      .run(i.id, JSON.stringify(i));
  }
  exclude(i: Instrument) {
    this.db
      .prepare(
        'INSERT INTO watch VALUES(?,?,0,0,1) ON CONFLICT(id) DO UPDATE SET pinned=0,auto=0,excluded=1',
      )
      .run(i.id, JSON.stringify(i));
  }
  restore(i: Instrument) {
    this.db.prepare('UPDATE watch SET excluded=0 WHERE id=?').run(i.id);
  }
  selectAuto(instruments: Instrument[]) {
    this.transaction(() => {
      this.db.exec('UPDATE watch SET auto=0');
      let count = 0;
      for (const i of instruments) {
        const row = this.watchRows().find((r) => r.instrument.id === i.id);
        if (row?.excluded || row?.pinned) continue;
        if (count++ >= 10) break;
        this.db
          .prepare('INSERT INTO watch VALUES(?,?,0,1,0) ON CONFLICT(id) DO UPDATE SET auto=1')
          .run(i.id, JSON.stringify(i));
      }
    });
  }
  monitored(): Instrument[] {
    const selected = this.watchRows()
      .filter((r) => !r.excluded && (r.auto || r.pinned))
      .map((r) => r.instrument);
    return [
      ...new Map(
        [...selected, ...this.activeIdeas().map((i) => i.candidate.instrument)].map((i) => [
          i.id,
          i,
        ]),
      ).values(),
    ];
  }
  cache(i: Instrument, interval: string, bars: Bar[]) {
    if (this.db.mode === 'cloud') {
      const merged = new Map(this.bars(i, interval).map((b) => [b.start, b]));
      for (const b of bars) merged.set(b.start, b);
      const sorted = [...merged.values()].sort((a, b) => a.start - b.start);
      const recent = sorted.filter(
        (b) => b.start >= (sorted.at(-1)?.start ?? 0) - (interval === '15m' ? 35 : 800) * 86400000,
      );
      this.db
        .prepare(
          'INSERT INTO candles VALUES(?,?,?,?) ON CONFLICT(instrument,interval,start) DO UPDATE SET body=excluded.body',
        )
        .run(i.id, interval, -1, JSON.stringify(recent));
      return;
    }
    this.transaction(() => {
      const insert = this.db.prepare(
        'INSERT INTO candles VALUES(?,?,?,?) ON CONFLICT(instrument,interval,start) DO UPDATE SET body=excluded.body',
      );
      for (const b of bars) insert.run(i.id, interval, b.start, JSON.stringify(b));
    });
  }
  bars(i: Instrument, interval: string, start = 0): Bar[] {
    if (this.db.mode === 'cloud') {
      const row = this.db
        .prepare('SELECT body FROM candles WHERE instrument=? AND interval=? AND start=-1')
        .get(i.id, interval) as Row | undefined;
      return row ? (JSON.parse(String(row.body)) as Bar[]).filter((b) => b.start >= start) : [];
    }
    return (
      this.db
        .prepare(
          'SELECT body FROM candles WHERE instrument=? AND interval=? AND start>=? ORDER BY start',
        )
        .all(i.id, interval, start) as Row[]
    ).map((r) => JSON.parse(String(r.body)));
  }
  prune(now: number) {
    if (this.db.mode === 'cloud') return;
    this.db
      .prepare("DELETE FROM candles WHERE interval='15m' AND start<?")
      .run(now - 35 * 86_400_000);
    this.db
      .prepare("DELETE FROM candles WHERE interval='1d' AND start<?")
      .run(now - 800 * 86_400_000);
  }
  idea(id: string): Idea | undefined {
    const r = this.db.prepare('SELECT body FROM ideas WHERE id=?').get(id) as Row | undefined;
    return r ? JSON.parse(String(r.body)) : undefined;
  }
  activeIdeas(): Idea[] {
    return (this.db.prepare('SELECT body,state FROM ideas').all() as Row[])
      .filter((r) => !terminalStates.has(String(r.state) as Idea['state']))
      .map((r) => JSON.parse(String(r.body)));
  }
  activeEntries(): number {
    return this.activeIdeas().filter((i) => i.candidate.entry !== undefined).length;
  }
  saveIdea(idea: Idea, events: SignalEvent[], publish = true) {
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO ideas VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,state=excluded.state',
        )
        .run(idea.candidate.id, JSON.stringify(idea), idea.state);
      for (const e of events) {
        const changed = this.db
          .prepare('INSERT OR IGNORE INTO events(id,idea_id,body) VALUES(?,?,?)')
          .run(e.id, e.ideaId, JSON.stringify(e)).changes;
        if (changed && publish && !e.recovery) {
          const route: Route =
            e.state === 'watching' || e.state === 'setup_ready' || e.state === 'entry_triggered'
              ? e.instrument.market === 'equity'
                ? 'equity_ideas'
                : 'crypto_ideas'
              : 'updates';
          this.db
            .prepare('INSERT OR IGNORE INTO outbox(event_id,route) VALUES(?,?)')
            .run(e.id, route);
        }
      }
    });
  }
  journal(id?: string): SignalEvent[] {
    return (
      id
        ? this.db.prepare('SELECT body FROM events WHERE idea_id=? ORDER BY seq').all(id)
        : (this.db.prepare('SELECT body FROM events ORDER BY seq').all() as Row[])
    ).map((r) => JSON.parse(String((r as Row).body)));
  }
  enqueue(e: SignalEvent, route: Route) {
    this.transaction(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO events(id,idea_id,body) VALUES(?,?,?)')
        .run(e.id, e.ideaId, JSON.stringify(e));
      this.db.prepare('INSERT OR IGNORE INTO outbox(event_id,route) VALUES(?,?)').run(e.id, route);
    });
  }
  pending(now: number): { event: SignalEvent; route: Route; attempts: number }[] {
    return (
      this.db
        .prepare(
          "SELECT e.body,o.route,o.attempts FROM outbox o JOIN events e ON e.id=o.event_id WHERE status='pending' AND next_attempt<=? ORDER BY e.seq LIMIT 25",
        )
        .all(now) as Row[]
    ).map((r) => ({
      event: JSON.parse(String(r.body)),
      route: String(r.route) as Route,
      attempts: Number(r.attempts),
    }));
  }
  pendingCount() {
    return Number(
      (this.db.prepare("SELECT count(*) AS n FROM outbox WHERE status='pending'").get() as Row).n,
    );
  }
  hasIdeaPublication(ideaId: string): boolean {
    return (
      !!this.thread(ideaId) ||
      !!this.db
        .prepare(
          'SELECT 1 FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.idea_id=? LIMIT 1',
        )
        .get(ideaId)
    );
  }
  receipt(eventId: string, destination: string): string | undefined {
    const row = this.db
      .prepare('SELECT message_id FROM delivery_receipts WHERE event_id=? AND destination=?')
      .get(eventId, destination) as Row | undefined;
    return row ? String(row.message_id) : undefined;
  }
  saveReceipt(eventId: string, destination: string, messageId: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO delivery_receipts VALUES(?,?,?)')
      .run(eventId, destination, messageId);
  }
  delivered(id: string) {
    this.db
      .prepare("UPDATE outbox SET status='delivered',last_error=NULL WHERE event_id=?")
      .run(id);
  }
  failed(id: string, now: number, attempts: number, code: string) {
    this.db
      .prepare('UPDATE outbox SET attempts=attempts+1,next_attempt=?,last_error=? WHERE event_id=?')
      .run(now + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7)), code, id);
  }
  thread(id: string): { channel: string; message: string; thread?: string } | undefined {
    const r = this.db.prepare('SELECT * FROM threads WHERE idea_id=?').get(id) as Row | undefined;
    return r
      ? {
          channel: String(r.channel_id),
          message: String(r.message_id),
          thread: r.thread_id ? String(r.thread_id) : undefined,
        }
      : undefined;
  }
  saveThread(id: string, channel: string, message: string, thread?: string) {
    this.db
      .prepare(
        'INSERT INTO threads VALUES(?,?,?,?) ON CONFLICT(idea_id) DO UPDATE SET thread_id=COALESCE(excluded.thread_id,threads.thread_id)',
      )
      .run(id, channel, message, thread ?? null);
  }
  cooldown(key: string, time: number, interval = 14_400_000): boolean {
    const r = this.db.prepare('SELECT time FROM cooldowns WHERE key=?').get(key) as Row | undefined;
    if (r && time - Number(r.time) < interval) return false;
    this.db
      .prepare(
        'INSERT INTO cooldowns VALUES(?,?) ON CONFLICT(key) DO UPDATE SET time=excluded.time',
      )
      .run(key, time);
    return true;
  }
}
