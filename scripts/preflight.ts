import { commands } from '../src/discord/commands.js';
import { mkdir, writeFile } from 'node:fs/promises';
const checks: Record<string, boolean> = {};
checks.secrets = [
  'DISCORD_TOKEN',
  'DISCORD_PUBLIC_KEY',
  'DISCORD_APPLICATION_ID',
  'DISCORD_GUILD_ID',
  'ALPACA_API_KEY',
  'ALPACA_API_SECRET',
  'TEST_CHANNEL_ID',
].every((k) => !!process.env[k]);
checks.freePlanConfirmed = process.env.FREE_PLAN_CONFIRMED === 'true';
checks.commandsValid = commands.every((c) => !!c.toJSON().name);
for (const [name, url] of [
  ['discord', 'https://discord.com/api/v10/gateway'],
  ['coinbase', 'https://api.exchange.coinbase.com/time'],
  [
    'alpaca',
    'https://data.alpaca.markets/v2/stocks/bars?symbols=SPY&timeframe=1Day&feed=sip&end=' +
      new Date(Date.now() - 16 * 60000).toISOString(),
  ],
] as const) {
  try {
    const response = await fetch(url, {
      headers:
        name === 'alpaca'
          ? {
              'APCA-API-KEY-ID': process.env.ALPACA_API_KEY ?? '',
              'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET ?? '',
            }
          : {},
      signal: AbortSignal.timeout(15000),
    });
    checks[name] = response.ok;
  } catch {
    checks[name] = false;
  }
}
const report = {
  createdAt: Date.now(),
  passed: Object.values(checks).every(Boolean),
  checks,
  note: 'This local check does not prove deployed Worker CPU limits, account-wide free allowances, permissions, or the seven-day soak. Verify those on Cloudflare.',
};
await mkdir('output', { recursive: true });
await writeFile('output/preflight.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
