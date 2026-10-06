import { it, expect } from 'vitest';
import { verifySignature } from '../src/worker/signature.js';
import { CloudSql } from '../src/worker/sql.js';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { diagnosticCode } from '../src/core/errors.js';
import { activationIssues } from '../src/worker/activation.js';
import { failureMessage, failureResponse } from '../src/worker/failures.js';
it('reports Discord authentication and access failures without forwarding raw errors', async () => {
  const error = Object.assign(new Error('Request contained private-token'), {
    name: 'DiscordAPIError[0]',
    status: 401,
    code: 0,
  });
  const message = await failureMessage(failureResponse(error, 'discord_identity'));
  expect(message).toContain('DISCORD_INVALID_TOKEN');
  expect(message).toContain('Step: discord_identity');
  expect(message).toContain('DISCORD_TOKEN');
  expect(message).not.toContain('private-token');
  expect(diagnosticCode(Object.assign(error, { status: 403, code: 50001 }))).toBe(
    'DISCORD_MISSING_ACCESS',
  );
  expect(diagnosticCode(Object.assign(error, { status: 403, code: 50013 }))).toBe(
    'DISCORD_MISSING_PERMISSIONS',
  );
});
it('does not relay unstructured coordinator responses or unknown error contents', async () => {
  expect(await failureMessage(new Response('private-token', { status: 503 }))).toContain(
    'COORDINATOR_HTTP_503',
  );
  const message = await failureMessage(
    Response.json({ error: 'private-token', stage: 'private-token' }, { status: 503 }),
  );
  expect(message).toContain('WORKER_OPERATION_FAILED');
  expect(message).not.toContain('private-token');
});
it('reports each activation blocker without including credential values', () => {
  const configured = {
    FREE_PLAN_CONFIRMED: 'true',
    DISCORD_TOKEN: 'private-token',
    DISCORD_GUILD_ID: '123',
    ALPACA_API_KEY: 'private-key',
    ALPACA_API_SECRET: 'private-secret',
  };
  expect(activationIssues(configured)).toEqual([]);
  expect(activationIssues({ ...configured, FREE_PLAN_CONFIRMED: 'false' })).toEqual([
    'FREE_PLAN_CONFIRMED must be set to true after verifying the hosting free-plan checkpoint.',
  ]);
  const missing = activationIssues({ ...configured, ALPACA_API_SECRET: '  ' });
  expect(missing).toEqual(['ALPACA_API_SECRET is missing or empty.']);
  expect(missing.join(' ')).not.toContain('private-');
  expect(activationIssues({})).toHaveLength(5);
});
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
