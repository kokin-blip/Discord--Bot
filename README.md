# Discord Trading Signals

A signals-only Discord bot for one private server: weekly base breakouts, daily retests, completed 15-minute confirmations, and fixed target/invalidation tracking. Supports US stocks/ETFs and Coinbase USD spot pairs. No orders, futures, trailing stops, copy-trade feeds, or Coqui transport.

Hosting follows the updated Cloudflare Free requirement. A signed HTTP Worker handles Discord interactions, a single SQLite Durable Object coordinates scans and stores the journal/outbox, and Cloudflare Browser Run renders annotated TradingView Lightweight Charts. Node.js 24 runs development and validation tools; the deployed runtime is Cloudflare Workers rather than a Node server.

## Development

```sh
npm ci
npm run verify
npm run worker:build
npx playwright install chromium
npm run preview
npm run replay
```

Preview images and replay reports go into ignored `output/`. The default replay uses 30 **synthetic** fixtures; it demonstrates deterministic behavior, not historical validation or profitability. See [strategy interpretation](docs/STRATEGY.md), [validation](docs/VALIDATION.md), and [Cloudflare setup](docs/CLOUDFLARE.md).

Copy `.env.example` to `.env` for registration/preflight tools and `.dev.vars.example` to `.dev.vars` for local Wrangler. Enter secrets locally; neither file is committed. `npm run dev` runs the local Worker. Initial configuration leaves activation disabled.

## Commands

| Command                          | Purpose                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `/watch add/remove/restore/list` | Up to 10 manual pins, persistent exclusions, automatic selections             |
| `/chart symbol`                  | Annotated weekly/daily chart of a monitored instrument                        |
| `/scan`                          | Queue discovery and monitoring on the next scheduled invocation               |
| `/idea id`                       | Original idea levels and append-only lifecycle history                        |
| `/status`                        | Scan timestamps, instrument freshness/quality, outbox, pause and budget state |
| `/config channels`               | Six publishing routes; optional manager role                                  |
| `/config strategy`               | Validated numeric threshold changes with immutable strategy versions          |
| `/config alerts`                 | Master alert switch, volume/reversal toggles, multiplier, and options context |
| `/config validation`             | Administrator attestation after reviewing real historical examples            |
| `/pause`, `/resume`              | Pause/resume shared scans and publication within resource limits              |

All members can inspect; administrators or the configured manager role change shared lists/settings. Only administrators can grant the manager role or attest to validation. In test mode, all automatic messages go to `TEST_CHANNEL_ID`. Production requires all six destinations, permissions, historical-review attestation, and seven consecutive healthy days in test mode.

## Behavior

Watched symbols automatically publish qualified breakouts, daily retest readiness, and confirmed entries to their equity/crypto ideas channel. Each idea has one discussion thread; later cards stay visible in the main channel and their details are mirrored into the thread. Milestones and terminal outcomes use the updates channel. Before entry, cards and charts label the 0.5-ATR ranking reference, targets, and R/R as hypothetical; the actual retest trigger, allowed entry band, and remaining session window are separate. At entry, levels are finalized from the confirming close, which is a signal reference rather than a fill.

Initial monitoring and recovery can publish one current snapshot of a still-valid pre-entry setup that has never been announced. Historical entries remain suppressed. Per-destination delivery receipts prevent successful messages from being repeated when a thread mirror fails and retries. No manual `/scan` is needed for automatic strategy alerts. Test mode retains all publishing in the configured test channel.

Watchlist trackers run automatically on both daily and 15-minute candles. Volume spikes compare total volume against the preceding **10-day average** (matching session slots for intraday bars), defaulting to 2×. Cards differentiate buying, selling, and neutral pressure using close versus open, explicitly labeled as an estimate rather than measured buyer/seller volume. Reversal warnings freeze confirmed swing levels, then publish confirmation, cancellation, or expiry within five later completed candles. These alerts include annotated chart previews and use the watchlist route, preserve test-mode routing, and never create entries or change strategy levels.

Use `/config alerts enabled:true volume:true reversals:true volume_multiplier:2` to configure trackers. Both are enabled by default, including on older installations. Initial warm-up, recovery, and disabled periods advance state silently without replaying historical alerts. [Tracker rules](docs/STRATEGY.md#experimental-watchlist-trackers--watch-tracker-v1) describe the experimental reversal interpretation.

Daily discovery advances in bounded batches across active listings and retains the 300 most liquid eligible equities and 50 crypto pairs. Qualifying candidates are ranked deterministically; up to 10 become the automatic watchlist. Monitoring runs every five minutes, using at least 16-minute-old consolidated equity data. Market calendars account for holidays, early closes, and New York daylight saving time; crypto days/weeks use UTC/Monday.

Each idea preserves its original strategy version and levels. Completed bars drive lifecycle events; missing history pauses decisions. Revised historical prices/volume expire affected ideas and require a coherent refresh. Existing ideas remain monitored after watchlist removal. At most 20 nonterminal ideas are tracked simultaneously.

The journal and delivery outbox commit together. Restart replay journals old entries without advertising them as new actionable signals and produces a recovery summary. Message event IDs, Discord nonces, and recent-message checks reduce duplicates across delivery retries. Discord offers no transaction spanning a message send and this database; an extremely old unresolved delivery outside the 100-message search window still needs operator review.

## Resource limits and current release status

The implementation stops scans/publication at conservative SQLite row/request limits and falls back to text when chart rendering is unavailable. Charts are capped at 250 KiB and 60 image deliveries/day; the stricter browser reservation currently permits **at most eight render attempts/day**, shared with `/chart`, using eight of Cloudflare's ten free browser minutes. A failed attempt consumes its reservation. Confirm actual account-wide usage and browser closure during preflight; these counters cover this bot, not other Cloudflare workloads.

Local type checks, fixtures, chart rendering, Worker bundling, and local scheduled SQLite initialization have been exercised. Cloudflare deployment, authenticated provider access, a representative cloud workload, real historical review, and the seven-day private-channel soak remain release checkpoints requiring account/server configuration. Routine publication is gated accordingly.

`npm audit` currently reports upstream high-severity findings in the Cloudflare Puppeteer package's Node browser-download dependency chain (`extract-zip` and proxy/FTP dependencies). Those modules are absent from the generated Worker bundle; this app never downloads or extracts browser archives through Puppeteer. Review the upstream advisory before changing that usage. Do not downgrade to the obsolete version suggested by `npm audit fix --force`.

The strategy is experimental. Reference prices, target touches, and planned reward/risk are not fills, returns, or success probabilities.

`/watch add` offers searchable symbol quick picks for common stocks, ETFs and Coinbase USD pairs. Choose the market first to filter the dropdown, then pick a symbol or type a custom one. Suggestions are examples; normal provider, strategy, data-quality and pin-limit checks still apply. Command definitions update automatically after deployment; no reinvite is needed.

Use `/debug check` (optionally `symbol:BTC-USD`) for an ephemeral JSON attachment showing alert toggles, data freshness, tracker cursors, cached volume/baseline measurements, pending reversals, provider cooldowns, channel permissions and resource budgets. It does not fetch provider data or send alerts. `/debug test` is restricted to administrators/managers and sends a clearly labeled synthetic volume card with an annotated chart to `TEST_CHANNEL_ID` only. It tests publishing and rendering even during provider outages, uses normal resource limits and receipts, and leaves real ideas, tracker cursors and cooldowns untouched. If charts are unavailable, the reply explicitly reports text-only delivery. No synthetic events are queued for normal-channel publishing. Commands sync automatically after deployment.
