# Entry reliability and shadow research

Production still runs the existing br-v1 rules and version hashes. The three-policy research engine writes separate opportunities, decisions, positions and immutable results. It cannot publish, modify the watchlist, occupy production slots, add learning labels or affect `/scorecard`. `/learning entries` is available to members and returns an ephemeral summary and JSON attachment from stored data.

## Live reliability

Required daily and 15-minute history is checked throughout the retained range, including holes behind a current candle. Equities use the exchange calendar (including early closes and daylight saving); crypto uses UTC intervals. Durable repair ranges retain pagination cursors, attempts, retry times and unavailable ranges. At most two repair pages run after fresh monitoring/publication per coordinator invocation, inside the shared provider request and time limits. Successful pages persist before the next request. Empty provider history stays unavailable with backoff. Automatic retention remains 800 daily days and 35 intraday days; older requirements need external history.

Strategy evaluation and tracker-history failures are reported separately. Instrument continuity failures mark recovery processing silent; subsequent fresh candles can publish again after coherent evaluation. Catch-up entries retain recovery markings. Entry parents send complete text without awaiting optional charts/options; a persisted enrichment job later edits the same message. Failed enrichment never creates a replacement parent. Existing receipt identities remain authoritative.

Source observations store the first time each recent normalized candle version was seen. Detection, queue and first successful Discord delivery are stored separately from immutable events. Historical observation/delivery times cannot be inferred from a current deployment and remain unknown. Raw source observations retain 120 days; immutable measurements retain their frozen timing assumptions.

`/status`, `/health`, `/debug check` and `/config show` expose repairs, unresolved/unavailable history, per-instrument strategy/tracker health, timing coverage and shadow backlog. They make no repair or chart requests themselves. `/explain symbol` distinguishes an active idea's saved rules from current settings and shows confirmation blockers and permitted revised-policy intervals.

## Policies and comparison

Every cohort freezes the current production configuration and execution model. A setting change starts a new cohort; positions in older cohorts finish with their original rules. Processing uses cached data only, at most 50 policy/candle steps per tick (48 when processing all three together), and respects learning/resource pauses.

| Policy            | Daily retest and entry behavior                                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline          | Existing breakout, provisional 0.5-ATR R/R rejection, retest, confirmation, invalidation and expiry rules.                                                                                                                                                                       |
| Feasible entry    | Records provisional R/R without rejecting on it; skips retests with no permitted confirmation interval, then freezes the first feasible retest in the original ten-session window. Out-of-zone confirmation closes wait until invalidation or the original two-session deadline. |
| State-aware setup | Feasible-entry behavior; before entry, a daily close through the level fails the setup, and after retest a 15-minute close beyond its adverse extreme fails it. Post-entry invalidation remains the original breakout-level rule.                                                |

Intervals use the strict confirmation boundary, inclusive chase limits, breakout-level risk, existing minimum R/R and the actual nearest eligible target on each side of pivot boundaries. A farther target cannot be chosen solely to pass R/R. Bearish rules mirror bullish rules. All other numerical qualifications, targets, milestones and time exits remain fixed.

Opportunities record every qualification check, including baseline rejections, and pair policies by cohort, instrument, direction and breakout close. Each policy has independent capacity constraints on the same monitored universe. A known no-entry is zero exposure; missing observations are unknown. Reports separate equity/crypto and bullish/bearish results, close-based signal outcomes, protective-stop simulations, rejection funnels, frequency, net R, drawdown and missed winners. R sums assume comparable risk per opportunity, not a funded portfolio.

## Execution model v2

Execution begins after source availability, polling, Discord delivery and assumed user response. Prospective observations prefer recorded timestamps; shadow delivery remains modeled. Historical runs model the five-minute cadence and existing provider delay (16 minutes for consolidated equities), with retrospective source snapshots labeled explicitly. Default modeled delivery overhead and response are 60 seconds each. Sensitivities use zero overhead/response and a 180-second response. Observed deliveries remain observed even in sensitivities.

Only a bar opening at or after the permitted time can execute. Online 15-minute data uses the next eligible bar open and has coarse resolution; offline runs can use one-minute bars. Costs freeze per run: equities 10 bps slippage plus 5 bps fees per side; crypto 10 plus 60 bps per side. Doubled/tripled friction scenarios accompany the defaults. These are illustrative assumptions, not measured user costs. Gap stops and same-bar stop/target ambiguity retain conservative shared execution conventions. Short results are conditional on unmodeled borrow, funding and availability.

Legacy execution-v1 measurements remain immutable and readable. New entry-filter promotion cohorts use homogeneous execution-v2 evidence; old cohorts cannot qualify using mixed measurements. Reversal review requirements are unchanged. Shadow entry-policy IDs are never accepted by `/learning promote`. At least 56 prospective days, 100 resolved entries per policy, 20 entry days and 90% execution coverage are necessary for sufficient comparison evidence, alongside paired coverage. Calendar-week block confidence bounds accompany comparisons. These thresholds never authorize activation.

## Local historical workflow

Use Node 24 and existing local provider credentials. The tools read credentials; exports contain source metadata and candles, never credentials. Output belongs in ignored `output/`.

```sh
npm run research:collect -- --symbols AAPL,BTC-USD --out output/entry-research/history --max-pages 24
# Repeat the identical command to resume; dates/defaults freeze in the checkpoint.
npm run research:entries -- output/entry-research/history/research-input.json --out output/entry-research/runs
```

Use `--from YYYY-MM-DD --to YYYY-MM-DD` for explicit evaluation dates and `--execution-resolution 1m` for optional execution candles. Defaults collect three calendar years plus 800 daily days and 35 intraday days of warm-up. Provider history limits, missing leading history, incomplete calendars, gaps and interrupted jobs are explicit coverage errors. A partial export is usable for diagnostics but cannot establish complete historical performance. Each invocation checkpoints bounded pages under the existing request/time budget; repeat until complete or provider limitations are understood. Use a new output directory when changing symbols/dates/resolution/eligibility.

Symbols containing `-USD` use Coinbase; others use Alpaca. `--eligibility path.json` accepts an array of `{ "instrumentId": "alpaca:us_equity:AAPL", "from": 1704067200000, "to": 1735689600000 }` records for historical membership. All members must be included in `--symbols`; omitted history cannot be reconstructed. Today-only symbol lists disclose selection/survivorship limitations.

Source-page hashes, retrieval times, feed details, exchange calendars and coverage manifests persist with the checkpoint. Hashes establish reproducibility, not source authenticity or historical first availability. Every comparison attempt appends its configuration and input/code fingerprints to `attempts.jsonl` before running.

The chronological split is 18 months development, four three-month validation windows and six months reserved holdout. Opportunities with outcomes overlapping a split boundary, including unsettled outcomes, are purged as a pair. Short datasets disclose that the full split is unavailable. Default runs do not evaluate holdout. After freezing a development/validation attempt, `--include-holdout --frozen-manifest path/to/attempt-manifest.json` requires matching input/config/code fingerprints. Changing the policy requires a new recorded attempt. Historical results never replace the prospective comparison requirement or activate a policy.
