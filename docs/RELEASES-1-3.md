# Releases 1–3: operation and rollout

The [implementation plan](IMPROVEMENT-PLAN.md) defines the three stages and acceptance checks. Each stage has an immutable record in `src/releases.ts`. A deployment queues only the latest release announcement through the ordinary outbox; it does not replay earlier releases or send manual release messages.

## Member commands

| Command                                         | Behavior                                                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health`                                       | Readable monitoring/publication/queue summary and full cached diagnostics attachment.                                                                                                                 |
| `/status`                                       | Readable health summary and full runtime/strategy/learning diagnostic attachment.                                                                                                                     |
| `/explain symbol:ETH-USD`                       | Exact values and pass/fail checks from the setup detector; latest attempted candle in each direction, qualifying candidates and open ideas. Cached data only. Qualification is not an entry.          |
| `/ideas active`                                 | Open ideas, original version, reference levels, remaining sessions, calendar deadlines and data-quality pauses.                                                                                       |
| `/digest`                                       | Shared active ideas and recent journal changes from the last 24 hours, bounded to 200 source events and 50 displayed changes.                                                                         |
| `/follow add symbol:ETH-USD type:entries`       | Personal digest filter; types are all, entries, setups, updates and trackers. Limit 25 symbols. The symbol must already be monitored.                                                                 |
| `/follow remove symbol:ETH-USD`, `/follow list` | Manage only the invoking member's preferences. Removal works after shared monitoring ends.                                                                                                            |
| `/digest personal:true`                         | Uses the member's follows. Empty follows produce an empty personal digest, rather than all server activity. No unsolicited DMs, mentions or shared-list mutations.                                    |
| `/stats`                                        | One terminal lifecycle per idea, grouped by version/market/direction/benchmark regime. Unknown reference prices and ambiguous bars remain explicit. Counts are not fill performance or probabilities. |
| `/context symbol:ETH-USD`                       | Cached benchmark-relative context, directional concentration and sectors where supplied by the source. No invented sectors or measured correlation claims.                                            |
| `/config show`                                  | Read current strategy, routes and tracker settings.                                                                                                                                                   |
| `/watch list page:2`                            | 20 rows per page; complete list attached when multiple pages exist.                                                                                                                                   |

Administrators/managers use `/queue inspect` and `/queue retry id:<event>`. A delivery becomes dead after ten failed attempts and remains visible for review. Manual retry retains successful destination receipts. Inspect permissions and routing before retrying. Cached diagnostics remain accessible when scans/publication are paused or budget-limited; writing or rendering still respects runtime limits.

## Execution changes

Pending ideas obtain retests using frozen breakout levels, ATR and original strategy rules. Monitoring refresh failures are isolated by market, and intraday products save progress independently. Crypto datasets do not require Alpaca's calendar. Warm and cold daily histories are grouped by required start time; a cold instrument does not receive an incomplete warm-only refresh.

The live coordinator advances discovery separately between five-minute monitor polls. Monitoring refreshes prioritize instruments with active entries. Provider jobs stop launching requests after 24 attempts or 25 seconds, leaving room for Discord work; an individual request can still take its 20-second timeout. Completed products survive later failures. Daily discovery batches contain 50 equities or two crypto products. These are application limits, not a guarantee of account-wide quotas; measure the representative cloud workload.

Intraday downloads wait for a new completed slot. Identical charts share in-flight work and a process-local cache of at most eight images (250 KiB each) for 15 minutes. Six general 60-second browser reservations leave two of the daily eight reservations for entry events. Failed renders consume their reservation. This does not increase Cloudflare's browser allowance. Text delivery remains available.

Delayed entry messages more than 45 minutes after confirmation, obsolete setups and terminal ideas receive a historical label. Journal events and receipt IDs do not change. After initial production eligibility, updates to already published production calls can continue while a new version awaits review. Their own destination must still pass permissions, pause and quota checks. New signals require the healthy soak, historical attestation and all six destinations. Test delivery failures reset the test soak; production delivery failures enter the retry/review workflow.

For upgrades, existing idea roots in a distinct production ideas route can establish prior production publication. Roots in `TEST_CHANNEL_ID` cannot. All automatic test-mode delivery still uses the test channel. A channel configuration error unrelated to an existing call blocks new signals without silently suppressing that call's own permitted destination.

## Replay and simulation

`npm run replay -- /absolute/path/input.json` accepts a legacy dataset array as unverified correctness input. Manifest-backed historical input uses:

```json
{
  "datasets": ["replace with Dataset objects; one coherent history per instrument"],
  "strategy": "replace with the exact StrategyConfig object",
  "evidence": [
    {
      "source": "licensed provider/export reference",
      "retrievedAt": "2026-10-08T16:00:00Z",
      "sourceSha256": "replace with the 64-character raw-source SHA-256"
    }
  ],
  "costs": { "slippageBps": 10, "feeBps": 5, "holdoutFraction": 0.2 }
}
```

The evidence array aligns with datasets. Validate and preserve raw source files outside Git. A manifest records provenance; it does not prove authenticity. Historical mode rejects incomplete/gapped canonical histories. Reports record exact strategy/version and normalized input hash, reconstruct weekly bars from completed daily data, and enforce shared idea capacity and one pending direction per instrument. Review live discovery, polling delays, recovery and delivery separately. Without an input file the replay uses 30 unique synthetic fixtures, explicitly unverified.

`npm run simulate -- /absolute/path/input.json` writes `output/simulation-report.json`. It uses replayed entries, fills one simulated unit at the next bar's open with adverse slippage, charges fees on both sides, models a physical stop and the final target, and exits at the stop when both levels occur in the same OHLC candle. Gaps through the stop use the open. Time exits use the next bar's open. A next-bar gap that invalidates entry geometry is skipped. Missing future bars remain unknown. The chronological holdout is descriptive and does not tune parameters. Physical simulated stops differ from the public strategy's close-based invalidation; no portfolio sizing, liquidity, borrow cost or partial-target model is claimed.

Optional options context screens the first 100 indicative snapshots for directional calls/puts, 14–90 day expiries, strikes within 15% of the signal reference, two-sided quotes no older than 30 minutes, positive quoted sizes and at most 20% indicative spread. It ranks by strike proximity then spread and expiry, displaying at most six. Missing/stale quotes are omitted. Modified indicative quotes are not verified executable liquidity, and the bounded page is not the complete chain.

## Local checks and live rollout

Run `npm run verify` and `npm run worker:build` for every stage. Regression coverage includes frozen-rule retests, provider isolation, stale labels, production continuity, cache/request progress, explanations, preferences, authorization, outcome accounting and simulator ambiguity/costs. Run the synthetic replay and simulator smoke input as tool validation, never historical approval.

Keep the deployment in test mode until cloud connectivity, scheduler cadence, Browser Run closure/account usage, actual Discord permissions, delivery retry/recovery and a representative workload have been checked. Test each new command as a member and as a manager. Review real historical examples using the exact configuration in the report, record `/config validation`, and complete the seven-day private-channel soak before enabling new production signals. Local passing tests/bundling do not establish these live checkpoints. Credentials and bundled chart code are unchanged.
