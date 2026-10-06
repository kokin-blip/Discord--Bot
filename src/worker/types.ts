import type { DurableObjectNamespace, Fetcher } from '@cloudflare/workers-types';
export interface Env {
  BUILD_INFO?: { id: string; tag: string; timestamp: string };
  SIGNALS: DurableObjectNamespace;
  BROWSER: Fetcher;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_GUILD_ID: string;
  ALPACA_API_KEY: string;
  ALPACA_API_SECRET: string;
  TEST_CHANNEL_ID: string;
  RELEASE_MODE: 'test' | 'production';
  FREE_PLAN_CONFIRMED: string;
}
