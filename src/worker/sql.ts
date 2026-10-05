import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { SqlDatabase } from '../sql-store.js';
export class CloudSql implements SqlDatabase {
  mode = 'cloud';
  reads = 0;
  writes = 0;
  constructor(readonly storage: DurableObjectStorage) {}
  exec(sql: string) {
    return this.query(sql, []);
  }
  private query(sql: string, params: (string | number | null)[]) {
    const cursor = this.storage.sql.exec(sql, ...params);
    const rows = cursor.toArray();
    this.reads += cursor.rowsRead;
    this.writes += cursor.rowsWritten;
    return { rows, changes: cursor.rowsWritten };
  }
  prepare(sql: string) {
    return {
      run: (...params: (string | number | null)[]) => {
        const cursor = this.query(sql, params);
        return { changes: cursor.changes };
      },
      get: (...params: (string | number | null)[]) => this.query(sql, params).rows[0],
      all: (...params: (string | number | null)[]) => this.query(sql, params).rows,
    };
  }
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
  close() {}
}
