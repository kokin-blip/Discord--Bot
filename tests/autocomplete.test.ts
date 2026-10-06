import { expect, it, vi } from 'vitest';
import { commands } from '../src/discord/commands.js';
import { watchSuggestions } from '../src/discord/autocomplete.js';
import type { Env } from '../src/worker/types.js';
import type { ExecutionContext } from '@cloudflare/workers-types';
vi.mock('../src/worker/coordinator.js', () => ({ SignalCoordinator: class {} }));
import worker from '../src/worker/index.js';
const request = (query = '', market?: string) => ({
  data: {
    name: 'watch',
    options: [
      {
        name: 'add',
        options: [
          { name: 'symbol', value: query, focused: true },
          ...(market ? [{ name: 'market', value: market }] : []),
        ],
      },
    ],
  },
});
it('provides filtered quick picks, case-insensitive symbol/name searches and custom input', () => {
  expect(watchSuggestions(request()).length).toBeGreaterThan(10);
  expect(watchSuggestions(request()).length).toBeLessThanOrEqual(25);
  expect(watchSuggestions(request('', 'equity')).every((c) => !c.value.includes('-USD'))).toBe(
    true,
  );
  expect(watchSuggestions(request('', 'crypto')).every((c) => c.value.endsWith('-USD'))).toBe(true);
  expect(watchSuggestions(request('btc', 'crypto'))[0]?.value).toBe('BTC-USD');
  expect(watchSuggestions(request('apple', 'equity'))[0]?.value).toBe('AAPL');
  expect(
    watchSuggestions(request(' aapl ', 'equity')).filter((c) => c.value === 'AAPL'),
  ).toHaveLength(1);
  expect(watchSuggestions(request('BRK.B', 'equity'))).toContainEqual({
    name: 'BRK.B · Use custom symbol',
    value: 'BRK.B',
  });
  expect(watchSuggestions(request('bad!'))).toEqual([]);
  expect(watchSuggestions(request('', 'invalid'))).toEqual([]);
  expect(watchSuggestions({ data: { name: 'chart' } })).toEqual([]);
});
it('registers autocomplete for add while preserving unrestricted custom symbols', () => {
  const command = commands[0]!.toJSON() as any;
  const add = command.options.find((o: any) => o.name === 'add');
  expect(add.options.map((o: any) => o.name)).toEqual(['market', 'symbol']);
  expect(add.options[1].autocomplete).toBe(true);
  expect(add.options[1].choices).toBeUndefined();
});
it('answers signed autocomplete immediately without a scheduler, credentials or deferred message', async () => {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const key = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const fetch = async (guild: string, tamper = false) => {
    const body = JSON.stringify({ type: 4, guild_id: guild, ...request('btc', 'crypto') });
    const signature = Buffer.from(
      await crypto.subtle.sign(
        'Ed25519',
        pair.privateKey,
        new TextEncoder().encode(timestamp + body),
      ),
    ).toString('hex');
    return worker.fetch(
      new Request('https://bot/interactions', {
        method: 'POST',
        body: body + (tamper ? ' ' : ''),
        headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
      }),
      { DISCORD_PUBLIC_KEY: key, DISCORD_GUILD_ID: 'server' } as Env,
      {
        waitUntil: () => {
          throw new Error('Autocomplete must return synchronously');
        },
      } as unknown as ExecutionContext,
    );
  };
  const response = await fetch('server');
  expect(await response.json()).toMatchObject({
    type: 8,
    data: { choices: [{ value: 'BTC-USD' }] },
  });
  expect(await (await fetch('other-server')).json()).toEqual({ type: 8, data: { choices: [] } });
  expect((await fetch('server', true)).status).toBe(401);
});
