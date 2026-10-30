# Validation and release evidence

`npm run verify` checks TypeScript, deterministic fixtures, persistence/outbox behavior, adapters/calendar/quality, authorization, signed Discord requests, recovery, and resource caps. `npm run worker:build` verifies Worker bundling. Local Wrangler scheduled invocation additionally verifies that the Cloudflare SQLite schema can initialize; ordinary Node SQLite tests cannot establish that compatibility.

`npm run preview` produces bullish/bearish charts using the same frozen snapshot/candidate as its signal. Verify that weekly/daily panels, base, breakout/retest annotations, entry, all three targets, timestamps, and TradingView attribution are readable. It needs Playwright Chromium installed. Cloudflare uses the same snapshot renderer through its own browser binding and must be verified separately.

## Real historical replay

```sh
npm run replay -- /absolute/path/to/historical-datasets.json
```

Legacy correctness input is an array of `Dataset` objects from `src/domain.ts`: canonical instrument; chronological daily/weekly/15-minute bars (millisecond `start`/`end`, OHLCV); aligned benchmark daily bars; exchange sessions; and truthful data provenance. Crypto needs UTC days/Monday weeks; equities need the actual exchange calendar and adjusted histories. Preserve raw source, venue, retrieval timestamps, and the strategy version alongside the data. Reject gaps before using the report as evidence.

For historical evidence, supply the explicit per-dataset source manifest and exact strategy configuration described in [Releases 1–3](RELEASES-1-3.md). A provider-name string alone no longer enables historical classification. The script validates source manifests and canonical histories; source authenticity remains an administrator review.

The script advances through successive completed-candle timestamps, never providing future daily/weekly bars to the evaluator. It writes `output/replay-report.json` and prints its SHA-256. Without an input file, it runs 30 synthetic fixtures and explicitly refuses to call them historical evidence. A provider label alone does not establish authentic history; the administrator must review source data.

Review at least 30 diverse real examples: bullish and bearish, different liquidity/market regimes, successful confirmations, rejected setups, invalidations, missed retests, nearby targets, and expiry. Record the expected decision and why for each example. Check every event against data that was available at its timestamp, including pivot-confirmation timing. Historical replay is a rule-fidelity review, not a profitability backtest. This implementation does not simulate executions; future fill testing must use next-bar timing and explicit costs.

After reviewing the real report and source cases, an administrator records:

```
/config validation report_sha256:<64 hex characters> examples:30 failures:<reviewed rejection/invalidation count>
```

This is an explicit administrator attestation; it does not automate a claim of source authenticity or correctness. It cannot replace the review. Keep the reviewed data/report outside Git if licensed or private. Revalidate when a new strategy version is introduced.

## Live operational validation

The historical-review and seven-day private-test-soak publication blockers have been retired. Invite the bot with channel-management/publishing permissions and inspect automatic public channel creation, thread access, delayed-data labels, missing/revised history, restart recovery, rate limits, chart fallback, ordering, receipts and resource budgets. These observations remain useful validation evidence; they are not an automatic private-channel waiting period.

`/scorecard` must count only delivered real originating calls once per family, retain uncertain outcomes, disclose backfill coverage, and survive restart, late delivery and detailed-example pruning. Check that its signed Worker response is public while administrative replies remain private. Automatic setup must resume partial REST creation without duplicates, preserve overrides, recover deleted managed channels and expose missing permissions without breaking diagnostics.

Local mocks do not establish account-wide free eligibility, deployed provider connectivity, actual Discord permission behavior or profitability. Historical replay remains optional research evidence, and learning promotion still requires its own evidence checks and manager approval.

## Watch tracker validation

Local tests cover ten-day daily and matching-slot intraday baselines, exact equality at 2×, missing/zero samples, UTC boundaries, session offsets spanning DST, holidays and early closes. Mirrored reversal tests cover confirmed pivots known before warning open, warning/confirmation/cancellation/expiry, fifth-candle confirmation, cancellation precedence and frozen levels. Persistence tests cover restart deduplication, silent initial/recovery reconstruction, disabled/re-enabled trackers, independent timeframe cooldowns, long outages and atomic rollback. Publisher tests verify receipts/retries, TradingView links, no strategy entries or R/R fields, one reversal discussion thread (volume alerts have no thread), charts bounded at the event timestamp, and text fallback on rendering failure or exhausted image budgets.

Run `npm run preview:trackers` for synthetic buying-pressure, selling-pressure and reversal chart/card previews. Generated sample cards and daily/intraday annotated charts have been visually inspected locally (`output/tracker-*-preview.png`, ignored from Git). This is a layout preview, not proof of live Discord delivery. Inspect actual delivered cards in their public destinations; no synthetic market alerts are posted by the implementation. Buying/selling labels are candle-direction pressure estimates, not actual aggressor-side volume.

Use `/debug check` to inspect monitoring, resource limits and automatic channel setup without sending synthetic messages. `/debug test` and the private news smoke command are retired. Offline preview/smoke scripts remain available and cannot approve live publication.

## Controlled learning validation

See [learning records, shadow filters and release checks](LEARNING.md). Run `npx tsx scripts/preview-learning.ts` for local synthetic review/report previews. Inspect actual learning messages in public discussion threads; deployment no longer requires private-channel soak or historical attestation. Local tests cover outcome separation, feature timing, retention, bounded recovery, reports, counterfactual blocked successes, promotion/rollback and thread-only review retries.

`npm run simulate -- /absolute/path/research-input.json` is a separate offline execution model. Review its explicit costs, physical-stop assumptions, next-bar timing, unknown outcomes and chronological holdout. Its report is not a substitute for rule-fidelity review or deployed operational observations.

# Entry research validation

The [entry research workflow](ENTRY-RESEARCH.md) adds paired policy opportunities, modeled/observed execution timing, fixed friction scenarios, calendar-week uncertainty and chronological development/validation/holdout partitions. Local fixtures verify behavior, not profitability. Incomplete observations remain unknown; historical comparisons cannot satisfy prospective evidence requirements. Public production rules are unchanged.
