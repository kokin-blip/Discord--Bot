# Threshold indicator: stalled-trade exit reviews

The optional Threshold Indicator asks members to review a stalled trade. It never sends orders, records a sale, moves strategy targets/stops, or replaces the existing session-based `time_exit`. It ships with `enabled`, `ideas`, and `contracts` all **false**, including on existing installations.

## Enable and use

A manager/admin configures `/threshold config enabled:true ideas:true contracts:true`. Existing master alert, pause, resource, destination-permission and live publication checks still apply. Threshold alerts use the automatically managed public `trade-updates` route. No threshold card uses charts, images, threads, or browser allowance.

| Command                                                                                                        | Purpose                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/threshold add contract:<OCC symbol> entry:<premium> [quantity] [stop] [fees] [idea]`                         | Register your long standard equity/ETF call or put. Entry and stop are premiums per share; fees are round-trip dollars per contract. |
| `/threshold edit id:<monitor> [entry] [quantity] [stop] [clear_stop:true] [fees]`                              | Correct/adjust a monitor. Effective changes start a fresh observation window; empty edit explicitly restarts a suspended monitor.    |
| `/threshold list`                                                                                              | List active/suspended shared monitors and their owners/reasons.                                                                      |
| `/threshold show id:<monitor>`                                                                                 | Inspect frozen rules, timestamps, progress, eligibility, sampled peak, quotes, and forward review records.                           |
| `/threshold snooze id:<monitor>`                                                                               | After a delivered alert, request one reminder after one more market hour if the same stall still qualifies.                          |
| `/threshold stop id:<monitor>`                                                                                 | Stop tracking. This does not record or execute a sale.                                                                               |
| `/threshold config [enabled] [ideas] [contracts] [hours] [progress_atr] [contract_loss_percent] [idea_loss_r]` | Manager/admin settings; no options shows current settings.                                                                           |

Replies are ephemeral, but **future alerts publicly disclose the registered contract, owner ID, entered premium, quantity, entered fees/stop, and estimated P&L** to the public updates channel. Owners manage their monitors; managers/admins moderate all monitors and automatic idea monitors. Other members may inspect these shared records. There are no DMs or broker imports.

Up to five registered monitors/member and twenty/server are allowed, including suspended monitors. A member cannot register the same active/suspended contract twice; use edit for averaging or quantity changes. Quantity defaults to one. Omitted fees remain labeled **fees not included**. `clear_stop:true` removes the stop and disables loss prompts; do not combine it with `stop`.

Only standard long 100-share equity/ETF calls/puts are supported. Adjusted contracts, index options, shorts, spreads and broker position synchronization are excluded. Use exact standard OCC symbols (for example `AAPL261218C00250000`), not descriptions or option chains. The root must match an equity/ETF already selected or monitored for an active idea. An optional source idea must match the underlying and direction. Contract tracking continues independently of the source idea's lifecycle.

Removed/excluded symbols remain monitored for an active registered contract, without becoming automatic watchlist selections or generating strategy ideas/watch trackers solely for that contract. Watchlist listings/announcements identify retained symbols and preserve exclusions. Monitoring stops at regular-session close on expiration day; stopping/suspending tracking does not establish a broker fill.

## Progress, clock and eligibility

The default window is four market hours. Use completed 15-minute underlying closes, observed on the existing five-minute scan cadence. Equities/options count only regular-session overlaps in the provider calendar, including holidays, early closes and New York DST. Crypto ideas count continuously. Overnight/weekend equity time does not advance the clock.

Freeze daily ATR, using the existing ATR period and only completed daily data available when monitoring starts. A completed close at least `progress_atr × frozen ATR` beyond the last progress checkpoint resets the timer and starts a new episode: upward for bullish ideas/calls, downward for bearish ideas/puts. Default `progress_atr` is 0.25. Small advances accumulate relative to the checkpoint; adverse movement and tiny new highs/lows do not restart the clock.

Newly observed current entries begin at confirmation. Existing ideas on enablement and registered contracts begin a fresh window, with no inferred pre-monitor history. The window advances through completed underlying candle timestamps, so the equity feed's existing minimum 16-minute delay and candle/poll cadence also delay prompts and snooze reminders.

| Gate            | Default and calculation                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract return | `net = quantity × [100 × (indicative bid − entry) − round-trip fees per contract]`. Percent return is net divided by `quantity × 100 × entry`, times 100.                    |
| Contract loss   | At least −5%; a negative return also requires an entered stop and valid indicative bid strictly above it. No stop means breakeven/profit prompts only.                       |
| Contract stop   | A valid bid at/below the entered stop suspends the monitor. Invalid/stale quotes do not establish a stop breach. Use edit to update/restart, or stop tracking.               |
| Idea return     | Direction-adjusted movement from the original signal entry; not individual option P&L. Negative movement must be at least −0.05R, where R is entry-to-invalidation distance. |
| Profit          | Breakeven and any positive return qualify; there is no +5% upper cap.                                                                                                        |

For example, a bullish idea entered at $100 with $98 invalidation has R=$2: the default negative allowance reaches $99.90, not $95. Existing invalidation/terminal processing always takes precedence. Registered-contract stops are member-entered reference levels and are independent of linked idea invalidations.

Numeric settings are bounded: hours 1–24, progress ATR 0.05–2, contract loss 0–20%, idea loss 0–0.5R. Effective settings changes rebaseline active monitors, invalidate their unsent prompts, and preserve immutable prior numeric rule revisions. Old alerts retain their original evidence.

## Underlying range contraction

Four hours without progress is required even when candle ranges contract. For the latest four completed 15-minute candles, compare each high–low range with the previous ten eligible matching session-slot samples, then average the four ratios. An average at/below 0.50× is labeled contracted. All baseline samples and positive averages are required. Missing evidence is explicitly unavailable and does not disqualify an otherwise eligible stall.

This describes **underlying candle ranges**, not implied volatility or an IV collapse. The observed peak is the highest valid return sampled after tracking began, not the contract's historical maximum or a guaranteed available exit.

## Quotes and delivery

A separate exact-contract multi-quote request uses Alpaca `feed=indicative`; the existing optional option-chain context selector is unchanged. Alpaca documents that this free feed modifies quotes: [latest-quotes API](https://docs.alpaca.markets/us/reference/optionlatestquotes). Cards therefore say **indicative estimated P&L** and ask the member to check their broker's current quote. A bid-based estimate is neither executable liquidity nor a realized return.

Require finite positive prices, ask ≥ bid, positive sizes, bid size covering entered quantity, spread ≤20% of midpoint, and a timestamp from the last five minutes that is not in the future. Missing/unusable quotes mean unable to evaluate, never breakeven. Fetch at most twenty unique contracts in one batch per poll, share quotes across owners, and allow at most two HTTP attempts inside the existing shared request/time window. Lifecycle work comes first; exhaustion defers threshold work. Quote-provider failures do not reset core market monitoring.

State advancement, journal and outbox enqueue commit together. Deterministic event IDs, nonces, recent-message reconciliation and receipts prevent repeat delivery. An episode's allowance is consumed only after a successful receipt. One delivered alert remains consumed even if returns leave/re-enter the gate. Only meaningful progress rearms an automatic alert; an explicit snooze authorizes one additional reminder.

Before a send, recheck current settings, status, episode, stop/return gates, quote/candle freshness and permissions. Unsent prompts expire after ten wall-clock minutes. Obsolete attempts remain in the journal as suppressed, and a suppressed/failed attempt does not consume future valid delivery. As with existing Discord delivery, an unresolved send outside the recent-message search window requires operator review.

Routine restarts preserve timers/receipts. Interruptions over ten minutes, disable/re-enable, revised/missing underlying history and rule edits require a fresh observation window and suppress old queued prompts. Temporary option-quote failures alone preserve underlying checkpoints. Existing controls still gate publication.

Forward reviews retain alert context and best-effort observations at one and four additional market hours after delivery. If tracking ends, monitoring is disabled, or suitable evidence does not arrive within thirty additional market minutes, the observation remains explicitly unknown. They are separate from strategy statistics, learning and realized results, and are inspectable with `/threshold show`.

## Verification and rollout

Run `npm run verify`, `npm run worker:build`, `node --import tsx scripts/threshold-worker-smoke.ts` for a local workerd SQLite schema/restart/immutability check, and the offline threshold tests (`npx vitest run tests/threshold-*.test.ts`). Fixtures cover calendars, exact boundaries, calls/puts, fee/size effects, stops, owner/manager access, rule changes, missing/stale evidence, restart/receipt recovery, atomic rollback, forward reviews, and twenty registered monitors. Synthetic results validate behavior, not trading effectiveness.

After enabling this optional feature, inspect an automatic idea alert and a registered contract alert, including a small loss above an entered stop, contraction/unknown context, a snooze reminder, restart deduplication, and stale-quote suppression. Measure the representative watchlist/idea/twenty-contract workload and confirm free-plan headroom. Pause, permissions, data quality and resource limits still apply; local tests cannot substitute for deployed provider access or live channel evidence.

The immutable major-release record is announced by the existing durable release outbox. Never send release messages manually or bump its ID for routine fixes/redeploys. Credentials, subscriptions and the bundled chart library are unchanged by this feature.
