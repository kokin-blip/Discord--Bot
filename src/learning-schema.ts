import type { SqlDatabase } from './sql-store.js';

export function initializeLearningSchema(db: SqlDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_evaluations(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,family TEXT NOT NULL,version TEXT NOT NULL,ends_at INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS learning_evaluations_source ON learning_evaluations(source_id);
    CREATE TABLE IF NOT EXISTS learning_decisions(id TEXT PRIMARY KEY,evaluation_id TEXT NOT NULL,sample_id TEXT NOT NULL,callout_time INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS learning_decisions_evaluation ON learning_decisions(evaluation_id,callout_time,id);
    CREATE TABLE IF NOT EXISTS learning_evaluation_results(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_evaluation_work(id TEXT PRIMARY KEY,checked_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_observations(sample_id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS learning_observations_work ON learning_observations(updated_at,sample_id);
    CREATE TABLE IF NOT EXISTS learning_measurements(sample_id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_diagnostics(sample_id TEXT PRIMARY KEY,finalized_at INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS learning_diagnostics_recent ON learning_diagnostics(finalized_at,sample_id);
  `);
  for (const table of [
    'learning_evaluations',
    'learning_decisions',
    'learning_evaluation_results',
    'learning_measurements',
    'learning_diagnostics',
  ]) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Learning evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Learning evidence is immutable'); END;
    `);
  }
}
