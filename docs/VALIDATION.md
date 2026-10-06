# Validation and release evidence

`npm run verify` checks TypeScript, deterministic fixtures, persistence/outbox behavior, adapters/calendar/quality, authorization, signed Discord requests, recovery, and resource caps. `npm run worker:build` verifies Worker bundling. Local Wrangler scheduled invocation additionally verifies that the Cloudflare SQLite schema can initialize; ordinary Node SQLite tests cannot establish that compatibility.

`npm run preview` produces bullish/bearish charts using the same frozen snapshot/candidate as its signal. Verify that weekly/daily panels, base, breakout/retest annotations, entry, all three targets, timestamps, and TradingView attribution are readable. It needs Playwright Chromium installed. Cloudflare uses the same snapshot renderer through its own browser binding and must be verified separately.

## Real historical replay

```sh
npm run replay -- /absolute/path/to/historical-datasets.json
```

Input is an array of `Dataset` objects from `src/domain.ts`: canonical instrument; chronological daily/weekly/15-minute bars (millisecond `start`/`end`, OHLCV); aligned benchmark daily bars; exchange sessions; and truthful data provenance. Crypto needs UTC days/Monday weeks; equities need the actual exchange calendar and adjusted histories. Preserve raw source, venue, retrieval timestamps, and the strategy version alongside the data. Reject gaps before using the report as evidence.

The script advances through successive completed-candle timestamps, never providing future daily/weekly bars to the evaluator. It writes `output/replay-report.json` and prints its SHA-256. Without an input file, it runs 30 synthetic fixtures and explicitly refuses to call them historical evidence. A provider label alone does not establish authentic history; the administrator must review source data.

Review at least 30 diverse real examples: bullish and bearish, different liquidity/market regimes, successful confirmations, rejected setups, invalidations, missed retests, nearby targets, and expiry. Record the expected decision and why for each example. Check every event against data that was available at its timestamp, including pivot-confirmation timing. Historical replay is a rule-fidelity review, not a profitability backtest. This implementation does not simulate executions; future fill testing must use next-bar timing and explicit costs.

After reviewing the real report and source cases, an administrator records:

```
/config validation report_sha256:<64 hex characters> examples:30 failures:<reviewed rejection/invalidation count>
```

This is an explicit administrator attestation; it does not automate a claim of source authenticity or correctness. It cannot replace the review. Keep the reviewed data/report outside Git if licensed or private. Revalidate when a new strategy version is introduced.

## Private-channel soak

Run at least seven consecutive days with `RELEASE_MODE=test`. Inspect delayed-data labels, permission failures, missing candles/history revisions, disconnect/restart recovery, rate limits, chart fallback, event ordering, queued deliveries, quota resets, and inactive/removed-symbol monitoring. `/status` exposes scan/freshness/quality, pending deliveries, active entries, soak start, and budget counters. Check the Cloudflare dashboard for actual billed resource usage and provider entitlement.

Production remains unavailable without current seven-day health, administrator historical attestation, all configured routes, and channel permissions. Changing a strategy version resets its historical attestation and soak. Save review evidence before activation; unverified checkpoints remain outstanding.

## Known acceptance gaps requiring live evidence

Thirty diverse real historical examples have not yet been supplied/reviewed. The seven-day soak has not run. Cloudflare account-wide free eligibility, deployed resource usage/provider connectivity, and actual Discord permission/card/thread behavior are not established by local mocks. Preserve test mode until these checks pass.

## Watch tracker validation

Local tests cover ten-day daily and matching-slot intraday baselines, exact equality at 2×, missing/zero samples, UTC boundaries, session offsets spanning DST, holidays and early closes. Mirrored reversal tests cover confirmed pivots known before warning open, warning/confirmation/cancellation/expiry, fifth-candle confirmation, cancellation precedence and frozen levels. Persistence tests cover restart deduplication, silent initial/recovery reconstruction, disabled/re-enabled trackers, independent timeframe cooldowns, long outages and atomic rollback. Publisher tests verify receipts/retries, TradingView links, no strategy entries or R/R fields, no threads, charts bounded at the event timestamp, and text fallback on rendering failure or exhausted image budgets.

Run `npm run preview:trackers` for synthetic buying-pressure, selling-pressure and reversal chart/card previews. Generated sample cards and daily/intraday annotated charts have been visually inspected locally (`output/tracker-*-preview.png`, ignored from Git). This is a layout preview, not proof of live Discord delivery. Inspect qualifying cards in the configured private test channel before normal-channel release; no synthetic market alerts are posted by the implementation. Buying/selling labels are candle-direction pressure estimates, not actual aggressor-side volume.
