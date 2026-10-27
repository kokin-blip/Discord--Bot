import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { Store } from '../src/sql-store.js';
import { CloudSql } from '../src/worker/sql.js';
import { LearningEvaluations } from '../src/learning-evaluation.js';
import { strategyVersion } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';

it('initializes the additive learning schema repeatedly through CloudSql and preserves immutable evidence', () => {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: {
      databaseSize: 0,
      exec(sql: string, ...params: (string | number | null)[]) {
        let rows: unknown[] = [];
        if (params.length || /^\s*(SELECT|PRAGMA)/i.test(sql))
          rows = db.prepare(sql).all(...params);
        else db.exec(sql);
        const changes = Number((db.prepare('SELECT changes() AS n').get() as { n: number }).n);
        return { toArray: () => rows, rowsRead: rows.length, rowsWritten: changes };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  try {
    const store = new Store(new CloudSql(storage));
    const evaluations = new LearningEvaluations(store);
    const candidate = evaluations.create(
      'cloud',
      'strategy_entry',
      strategyVersion(defaults),
      'filter',
      { filter: 'volume025' },
      1000,
    );
    const reopened = new Store(new CloudSql(storage));
    expect(new LearningEvaluations(reopened).get(candidate.id)).toEqual(candidate);
    expect(() => reopened.db.exec("UPDATE learning_evaluations SET body='{}'")).toThrow(
      'immutable',
    );
    reopened.db
      .prepare('INSERT INTO learning_diagnostics VALUES(?,?,?)')
      .run('diagnostic', 1000, '{}');
    expect(() => reopened.db.exec('DELETE FROM learning_diagnostics')).toThrow('immutable');
  } finally {
    db.close();
  }
});
