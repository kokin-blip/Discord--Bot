import { expect, it } from 'vitest';
import worker from '../src/worker/index.js';
import type { Env } from '../src/worker/types.js';
import type { ExecutionContext } from '@cloudflare/workers-types';

it('publicly defers signed scorecard commands while other commands and wrong-server errors stay private', async () => {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString(
    'hex',
  );
  const env = {
    DISCORD_PUBLIC_KEY: publicKey,
    DISCORD_GUILD_ID: 'guild',
    FREE_PLAN_CONFIRMED: 'true',
    DISCORD_TOKEN: 'synthetic',
    ALPACA_API_KEY: 'synthetic',
    ALPACA_API_SECRET: 'synthetic',
    SIGNALS: {
      idFromName: (s: string) => s,
      get: () => ({ fetch: async () => new Response('Handled') }),
    },
  } as unknown as Env;
  for (const [command, guild, flags] of [
    ['scorecard', 'guild', 0],
    ['learning', 'guild', 64],
    ['stats', 'guild', 64],
    ['scorecard', 'wrong', 64],
  ] as const) {
    const body = JSON.stringify({ type: 2, guild_id: guild, data: { name: command } });
    const time = String(Math.floor(Date.now() / 1000));
    const signature = Buffer.from(
      await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(time + body)),
    ).toString('hex');
    const work: Promise<unknown>[] = [];
    const result = await worker.fetch(
      new Request('https://bot/interactions', {
        method: 'POST',
        body,
        headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': time },
      }),
      env,
      { waitUntil: (p: Promise<unknown>) => work.push(p) } as unknown as ExecutionContext,
    );
    expect(await result.json()).toMatchObject({ type: guild === 'guild' ? 5 : 4, data: { flags } });
    await Promise.all(work);
  }
});
it('does not expose the coordinator diagnostic binding on the public Worker', async () => {
  for (const method of ['GET', 'POST']) {
    const response = await worker.fetch(
      new Request('https://bot/diagnostics?discord=1', { method }),
      {} as Env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
  }
});
