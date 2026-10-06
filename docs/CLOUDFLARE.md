# Cloudflare Free setup and feasibility checkpoint

The user replaced the Google Compute Engine target with Cloudflare Free. No VM, systemd service, IPv4/NAT provisioning, or paid networking is configured.

Official references: [Discord HTTP interactions on Workers](https://docs.discord.com/developers/tutorials/hosting-on-cloudflare-workers), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/).

## Account checkpoint

Use a Workers **Free** account with SQLite Durable Objects and Browser Run available. Confirm other applications do not consume the reserved allowance. Do not enable a paid plan to work around a failure. An absent or false `FREE_PLAN_CONFIRMED` disables activation; only set it to true after verifying the account's actual plan and allowance availability. Application counters cannot prove account billing configuration.

The free platform currently allows 100,000 Worker requests/day, 10 ms Worker CPU/request, 128 MB memory, five million SQL rows read/day, 100,000 written/day, and 5 GB total SQLite storage. The Worker does lightweight request authentication/forwarding; scanning lives in the Durable Object. The generated bundle is below the free compressed size limit. The bot pauses at four million SQL reads, 80,000 writes, or 80,000 coordinator requests/day, or 4 GB of this database. Cached candles use bounded JSON rows to avoid per-candle write costs. Journal history is append-only; monitor total database growth and export/back up before storage approaches the account limit.

Browser Run allows ten browser minutes/day and one launch every 20 seconds. The bot reserves 60 seconds per attempt, caps reservations at 480 seconds/day, applies a 15-second render deadline, closes browsers explicitly, and falls back to text. It separately caps delivered images at 60/day and 250 KiB each. Verify closure and actual browser usage in the dashboard on the deployed account. Free quotas are shared across the account, so use a dedicated account or leave room for its other workloads.

## Install and configuration

1. Create a Discord application/bot and invite it to the private server with `bot` and `applications.commands` scopes. Grant View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Create Public Threads, and Send Messages in Threads on every destination. Gateway/privileged intents are unnecessary; the code uses `discord.js` for REST and command structures without logging into the Gateway.
2. Obtain Alpaca Basic API credentials with calendar/assets access and historical SIP entitlement. Equity requests use `feed=sip`, adjusted history, and `end=now−16 minutes`; no paid live feed is required. Coinbase Exchange candle endpoints are public.
3. Run `npx wrangler login`. Review `wrangler.jsonc`, including your application ID. Its Worker name is `discord--bot`, matching the existing Workers Builds connection; Cloudflare requires the configured and connected names to match. Keep `RELEASE_MODE=test`.
4. Set secrets interactively:

```sh
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_GUILD_ID
npx wrangler secret put ALPACA_API_KEY
npx wrangler secret put ALPACA_API_SECRET
npx wrangler secret put TEST_CHANNEL_ID
```

5. Copy `.env.example` to `.env`, set local registration/preflight values, and run `npm run register` and `npm run preflight`. Registration requires only the bot token and application ID and replaces this application's global command list, with commands restricted to server installations and server channels. The deployed runtime still requires `DISCORD_GUILD_ID` for its single private server; global command registration does not enable multi-server scheduling or settings. The preflight tests local access, not deployed Cloudflare connectivity or performance.
6. After the account checkpoint, set the runtime variable `FREE_PLAN_CONFIRMED` to `true` in the Cloudflare dashboard and save/deploy. `keep_vars: true` preserves dashboard variables during repository deployments; do not add an explicit false override to `wrangler.jsonc`. Runtime variables/secrets belong under the Worker's Settings → Variables and Secrets, rather than only the build environment. Run `npm run worker:build`, then `npm run deploy`. Set Discord's Interactions Endpoint URL to `https://<your-worker>.workers.dev/interactions`. Discord's signed PING verification must succeed; unsigned payloads return HTTP 401.
7. Use `/status`, `/watch add`, and `/config channels`. All six routes must eventually be assigned: `equity_ideas`, `crypto_ideas`, `updates`, `watchlist`, `summaries`, `operations`. Several routes can share a channel. In test mode publication uses only the private test channel, regardless of normal destinations.

The scheduler invokes the single server coordinator once/minute. Discovery progresses in batches; intraday watchlist/active-idea polling runs at five-minute intervals. `/scan` queues work for the next invocation and publishes one completion summary after all discovery batches and monitoring finish, using the summaries destination (the test channel in test mode). The summary includes monitored symbols, data-quality pauses, active ideas, and active entries. Failed scans retain the request for retry without announcing success; `/status` shows the failure. Initial history warm-up can take longer than one poll; inspect provider errors and account usage rather than assuming immediate readiness.

## Representative workload

Before normal publication, exercise 10 auto selections, 10 manual pins, and up to 20 active ideas; include equity/crypto charts and a restart. Verify deployed access to Discord REST/uploads, Alpaca SIP/calendar, Coinbase candles, and Browser Run. Record CPU/memory, request/subrequest counts, SQL rows/storage growth, browser seconds/close reasons, response times, provider throttling, and queue drain. Keep headroom beneath free allowances. Missing entitlement, runtime limit failures, or unavailable free bindings are deployment blockers; stop activation and report the exact blocker.

Seven healthy days are measured by completed scans and monitored data quality. A gap over ten minutes, data-quality failure, or publication failure resets the soak. Production adds historical-review and destination validation gates. Set `RELEASE_MODE=production` and redeploy only after the validation procedure; do not clear gates to bypass a failed workload.

No deployment has been performed by the local implementation checks. Credentials and account confirmation are still required. The $0 feasibility checkpoint is therefore pending, rather than assumed passed.

## Connected build diagnostics

The repository already has a Workers Builds connection for `discord--bot`. GitHub exposes its pass/fail check but not detailed build logs; those require Cloudflare dashboard sign-in. If that check fails after the name match, inspect the linked build log for the exact cause. Do not infer that local bundling proves remote deployment. See [Cloudflare build troubleshooting](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/).
