import { it, expect } from 'vitest';
import { verifySignature } from '../src/worker/signature.js';
import { CloudSql } from '../src/worker/sql.js';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { diagnosticCode } from '../src/core/errors.js';
it('keeps provider failure codes without exposing arbitrary exception contents', () => {
  expect(diagnosticCode(new Error('DATA_HTTP_401:paper-api.alpaca.markets'))).toBe(
    'DATA_HTTP_401:paper-api.alpaca.markets',
  );
  expect(diagnosticCode(new Error('NETWORK_UNAVAILABLE:api.exchange.coinbase.com'))).toBe(
    'NETWORK_UNAVAILABLE:api.exchange.coinbase.com',
  );
  expect(diagnosticCode(new Error('TEST_CHANNEL_REQUIRED'))).toBe('TEST_CHANNEL_REQUIRED');
  expect(diagnosticCode(new Error('request failed with Authorization: secret-token'))).toBe(
    'WORKER_OPERATION_FAILED',
  );
  expect(diagnosticCode(new Error('DATA_HTTP_401:secret-token'))).toBe('WORKER_OPERATION_FAILED');
});
it('verifies Discord Ed25519 signatures and rejects changed, expired, and malformed requests', async () => {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const key = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex'),
    time = String(Math.floor(Date.now() / 1000)),
    body = '{"type":1}';
  const sig = Buffer.from(
    await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(time + body)),
  ).toString('hex');
  expect(await verifySignature(body, sig, time, key)).toBe(true);
  expect(await verifySignature(body + ' ', sig, time, key)).toBe(false);
  expect(await verifySignature(body, sig, time, key, Number(time) * 1000 + 300_001)).toBe(false);
  expect(await verifySignature(body, 'bad', time, key)).toBe(false);
  expect(await verifySignature(body, null, time, key)).toBe(false);
});
it('counts SQLite rows after consuming the cursor', () => {
  let consumed = false;
  const storage = {
    sql: {
      exec: () => ({
        get rowsRead() {
          return consumed ? 42 : 0;
        },
        rowsWritten: 1,
        toArray() {
          consumed = true;
          return [{ value: 7 }];
        },
      }),
    },
    transactionSync: (fn: () => unknown) => fn(),
  } as unknown as DurableObjectStorage;
  const sql = new CloudSql(storage);
  expect(sql.prepare('SELECT value').get()).toEqual({ value: 7 });
  expect(sql.reads).toBe(42);
  expect(sql.writes).toBe(1);
});
