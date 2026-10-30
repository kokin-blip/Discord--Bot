import type { SqlDatabase } from '../sql-store.js';

export function initializeEntryResearch(db: SqlDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_repairs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_observations(instrument TEXT NOT NULL,interval TEXT NOT NULL,start INTEGER NOT NULL,hash TEXT NOT NULL,observed_at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(instrument,interval,start,hash));
    CREATE INDEX IF NOT EXISTS source_observations_time ON source_observations(observed_at);
    CREATE TABLE IF NOT EXISTS entry_timings(event_id TEXT PRIMARY KEY,source_observed_at INTEGER,detected_at INTEGER NOT NULL,queued_at INTEGER);
    CREATE TABLE IF NOT EXISTS delivery_timings(event_id TEXT NOT NULL,destination TEXT NOT NULL,delivered_at INTEGER NOT NULL,PRIMARY KEY(event_id,destination));
    CREATE TABLE IF NOT EXISTS entry_enrichment(event_id TEXT NOT NULL,destination TEXT NOT NULL,message_id TEXT NOT NULL,status TEXT NOT NULL,next_attempt INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(event_id,destination));
    CREATE TABLE IF NOT EXISTS entry_cohorts(id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entry_research_work(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entry_opportunities(id TEXT PRIMARY KEY,cohort_id TEXT NOT NULL,instrument TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS entry_opportunities_cohort ON entry_opportunities(cohort_id,at,id);
    CREATE TABLE IF NOT EXISTS entry_positions(id TEXT PRIMARY KEY,cohort_id TEXT NOT NULL,policy TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS entry_positions_active ON entry_positions(cohort_id,policy,state);
    CREATE TABLE IF NOT EXISTS entry_results(id TEXT PRIMARY KEY,cohort_id TEXT NOT NULL,policy TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_measurements_v2(sample_id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_execution_work_v2(sample_id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,body TEXT NOT NULL);
  `);
  for (const table of [
    'entry_cohorts',
    'entry_opportunities',
    'entry_results',
    'learning_measurements_v2',
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Entry research evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Entry research evidence is immutable'); END;`);
  }
}
