import type { Store } from '../sql-store.js';
export interface NewsMigration {
  version: number;
  sql: string;
}
export const newsMigrations: readonly NewsMigration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE news_source_policies(id TEXT NOT NULL,version INTEGER NOT NULL,provider TEXT NOT NULL,scope TEXT NOT NULL,domain TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version),UNIQUE(provider,scope,domain,version));
CREATE TABLE news_articles(id TEXT PRIMARY KEY,url_hash TEXT UNIQUE NOT NULL,url TEXT NOT NULL,domain TEXT NOT NULL,first_ingested_at INTEGER NOT NULL,last_ingested_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX news_articles_expiry ON news_articles(expires_at);
CREATE TABLE news_observations(id TEXT PRIMARY KEY,provider TEXT NOT NULL,provider_article_id TEXT NOT NULL,article_id TEXT NOT NULL REFERENCES news_articles(id),ingested_at INTEGER NOT NULL,published_at INTEGER,first_seen_at INTEGER,expires_at INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(provider,provider_article_id));
CREATE INDEX news_observations_article ON news_observations(article_id);
CREATE INDEX news_observations_expiry ON news_observations(expires_at);
CREATE TABLE news_aliases(id TEXT PRIMARY KEY,instrument_id TEXT NOT NULL,alias TEXT NOT NULL,venue TEXT,reviewed_at INTEGER NOT NULL,body TEXT NOT NULL);
CREATE INDEX news_aliases_instrument ON news_aliases(instrument_id);
CREATE TABLE news_instrument_links(article_id TEXT NOT NULL REFERENCES news_articles(id),instrument_id TEXT NOT NULL,method TEXT NOT NULL,confidence REAL NOT NULL,evidence TEXT NOT NULL,mapping_version TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(article_id,instrument_id,mapping_version));
CREATE INDEX news_links_instrument ON news_instrument_links(instrument_id,expires_at);
CREATE TABLE news_events(id TEXT PRIMARY KEY,topic TEXT NOT NULL,event_class TEXT NOT NULL,severity TEXT NOT NULL,event_time INTEGER,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,analytics_version TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX news_events_candidates ON news_events(topic,event_class,created_at);
CREATE INDEX news_events_expiry ON news_events(expires_at);
CREATE TABLE news_event_articles(event_id TEXT NOT NULL REFERENCES news_events(id),article_id TEXT NOT NULL REFERENCES news_articles(id),PRIMARY KEY(event_id,article_id));
CREATE INDEX news_event_articles_article ON news_event_articles(article_id);
CREATE TABLE news_sentiments(id TEXT PRIMARY KEY,article_id TEXT REFERENCES news_articles(id),event_id TEXT REFERENCES news_events(id),instrument_id TEXT,origin TEXT NOT NULL,score REAL,confidence REAL NOT NULL,rules_version TEXT NOT NULL,expires_at INTEGER NOT NULL,body TEXT NOT NULL);
CREATE INDEX news_sentiments_instrument ON news_sentiments(instrument_id,expires_at);
CREATE TABLE news_queries(id TEXT PRIMARY KEY,provider TEXT NOT NULL,specification TEXT NOT NULL,priority INTEGER NOT NULL,due_at INTEGER NOT NULL,checkpoint TEXT,lease_id TEXT,lease_expires_at INTEGER,failures INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'ready');
CREATE INDEX news_queries_due ON news_queries(status,due_at,priority);
CREATE TABLE news_quota_days(provider TEXT NOT NULL,day TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(provider,day));
CREATE TABLE news_quota_reservations(id TEXT PRIMARY KEY,provider TEXT NOT NULL,day TEXT NOT NULL,query_id TEXT NOT NULL,reserved_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'reserved',completed_at INTEGER);
CREATE INDEX news_quota_reservations_day ON news_quota_reservations(provider,day);
CREATE TABLE news_deliveries(id TEXT PRIMARY KEY,event_id TEXT UNIQUE REFERENCES events(id),kind TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
CREATE INDEX news_deliveries_expiry ON news_deliveries(expires_at,status);
CREATE TABLE news_delivery_items(delivery_id TEXT NOT NULL REFERENCES news_deliveries(id),article_id TEXT NOT NULL REFERENCES news_articles(id),news_event_id TEXT REFERENCES news_events(id),policy_versions TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(delivery_id,article_id));
CREATE INDEX news_delivery_items_article ON news_delivery_items(article_id);
`,
  },
  {
    version: 2,
    sql: 'CREATE INDEX news_quota_reservations_time ON news_quota_reservations(reserved_at);',
  },
  {
    version: 3,
    sql: `
CREATE TABLE news_analysis_queue(article_id TEXT PRIMARY KEY REFERENCES news_articles(id),requested_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT);
CREATE INDEX news_analysis_due ON news_analysis_queue(next_at,requested_at);
CREATE TABLE news_analysis_state(article_id TEXT PRIMARY KEY REFERENCES news_articles(id),fingerprint TEXT NOT NULL,processed_at INTEGER NOT NULL);
CREATE TABLE news_publisher_groups(domain TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE INDEX news_events_version_candidates ON news_events(topic,event_class,analytics_version,created_at);
CREATE INDEX news_sentiments_article ON news_sentiments(article_id);
CREATE INDEX news_delivery_items_event ON news_delivery_items(news_event_id);
`,
  },
  {
    version: 4,
    sql: `
CREATE INDEX news_deliveries_kind_time ON news_deliveries(kind,created_at);
CREATE INDEX news_events_recent ON news_events(created_at,id);
CREATE INDEX news_events_alerts ON news_events(severity,created_at,id);
`,
  },
  {
    version: 5,
    sql: `
CREATE TABLE news_monitor_days(day TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE news_smoke_requests(id TEXT PRIMARY KEY,requested_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX news_smoke_expiry ON news_smoke_requests(expires_at);
CREATE INDEX news_smoke_recent ON news_smoke_requests(requested_at DESC,id DESC);
CREATE TABLE news_smoke_jobs(request_id TEXT NOT NULL REFERENCES news_smoke_requests(id),provider TEXT NOT NULL,status TEXT NOT NULL,attempt_id TEXT,diagnostic TEXT,PRIMARY KEY(request_id,provider));
CREATE INDEX news_smoke_pending ON news_smoke_jobs(status,provider);
`,
  },
];
/** Independent registry; do not touch the existing store's user_version. */
export function initializeNewsSchema(store: Store, now: number, migrations = newsMigrations): void {
  store.transaction(() => {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS news_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)',
    );
    const applied = store.db
      .prepare('SELECT version FROM news_migrations ORDER BY version')
      .all() as { version: number }[];
    if (
      applied.some((row) => !newsMigrations.some((migration) => migration.version === row.version))
    )
      throw new Error('NEWS_SCHEMA_UNSUPPORTED');
    for (const migration of migrations) {
      if (applied.some((row) => row.version === migration.version)) continue;
      store.db.exec(migration.sql);
      store.db.prepare('INSERT INTO news_migrations VALUES(?,?)').run(migration.version, now);
    }
  });
}
