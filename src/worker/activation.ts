import type { Env } from './types.js';

type ActivationEnv = Partial<
  Pick<
    Env,
    | 'FREE_PLAN_CONFIRMED'
    | 'DISCORD_TOKEN'
    | 'DISCORD_GUILD_ID'
    | 'ALPACA_API_KEY'
    | 'ALPACA_API_SECRET'
  >
>;

export function activationIssues(env: ActivationEnv): string[] {
  const issues: string[] = [];
  if (env.FREE_PLAN_CONFIRMED !== 'true')
    issues.push(
      'FREE_PLAN_CONFIRMED must be set to true after verifying the hosting free-plan checkpoint.',
    );
  for (const name of [
    'DISCORD_TOKEN',
    'DISCORD_GUILD_ID',
    'ALPACA_API_KEY',
    'ALPACA_API_SECRET',
  ] as const)
    if (!env[name]?.trim()) issues.push(`${name} is missing or empty.`);
  return issues;
}
