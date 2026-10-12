# Failure reviews and controlled learning

Learning is observational and deterministic. It records associations and tests filters; it does not identify proven market causes, estimate actual fills, or change live rules by itself. No paid model or additional market-data requests are used.

## Records and outcomes

The append-only operational journal remains intact. The separate learning tables hold temporary frozen snapshots for unresolved calls, detailed failure/exceptional-success examples, aggregate counts, and experiments. Detailed examples expire after 90 days and are capped at 1,000, oldest first. Ordinary successful calls contribute aggregate counts without a duplicate detailed learning case.

Reversal warnings resolve as cancelled (failure), confirmed (success), or expired (unconfirmed). Strategy setups resolve separately: invalidation is a failure, qualification for entry is a success, and expiry is unconfirmed. Confirmed entries resolve as final target (success), invalidation (failure), or time exit (failure for negative directional reference movement, otherwise success). Unknown prices and ambiguous target/invalidation ordering receive separate counts, never winning claims. Exceptional successful entries reach the final target or end at least 10% ahead of their reference in their stated direction. A setup success or reversal confirmation does not mean a profitable filled trade.

Snapshots use completed data available at the original callout, not its failure date. They include version, benchmark trend, applicable volume ratios, estimated candle-direction pressure, relative strength, ATR, and frozen levels/entry geometry. Missing history remains unknown. Old events without reliable snapshots cannot be backfilled. Recovery outcomes are journaled silently; historical failure reviews are not broadcast. Discontinuous reversal history or removal from monitoring resolves lost learning samples as unknown rather than inventing an outcome.

Failure reviews go only to the original discussion thread, after the public failure alert succeeds. Reversal warnings now have one thread each; follow-ups are mirrored without duplicate chart uploads. Reviews are text-only and reuse persisted outbox receipts. Ordinary signals take priority over learning deliveries.

## Reports and controls

- `/learning report`: complete cumulative aggregate report as a file. Groups separate family, market, direction, timeframe, version, and context. Failure rates use failure + success denominators, with unconfirmed, ambiguous and unknown counts listed separately. Fewer than 10 decisive outcomes is insufficient evidence.
- `/learning cases`: latest 20 retained detailed examples.
- `/learning experiments`: exploratory evidence, future pass/blocked counts, avoided failures, blocked successful calls, retained outcomes, coverage and review readiness. These are counterfactual filter counts, not profitability estimates.
- `/learning promote id:<experiment>` and `/learning rollback id:<experiment>`: administrators or the configured manager role only. Both reset historical validation and the seven-day soak when rules change. Original open-idea and pending-warning rules remain frozen.

Reports are queued on the first scheduler tick at or after Monday 00:00 UTC, once per week when new resolved outcomes exist. Installation establishes the initial week without an immediate report. Large reports attach their complete text. Test routing and production publication checks remain in force. `/status` includes learning backlog, pending samples, errors, resource pause and experiment readiness; long status responses are attached rather than truncated.

## Shadow filters

Supported proposals are benchmark SMA(50) alignment for reversal warnings, and breakout volume thresholds raised by 0.25 or 0.5 for strategy entries. Volume proposals measure confirmed-entry outcomes; pre-entry setup statistics remain a separate family. Thresholds never exceed the existing strategy schema limits.

A proposal needs 20 decisive eligible outcomes, five failures, at least five observations in each pass/blocked partition, and a blocked-group failure rate at least 15 percentage points higher than the passing group. Unknown benchmark/volume values are excluded from those comparisons. Evidence is grouped by original version and never pooled across incompatible rules. At most two experiments run concurrently. A source-version change archives incompatible experiments as superseded; already assigned calls can still finish their outcome counts, but those experiments cannot be promoted.

Only callouts occurring after proposal creation, under its source version, contribute future shadow evidence. Filters merely retain/block original callouts; original lifecycles determine both retained and blocked outcomes. No alternative orders, entries, levels or public alerts are created. Review readiness requires 28 days and 50 decisive future outcomes. Readiness alone is not a recommendation to promote. The human reviewer must examine blocked successes and signal coverage, not only avoided failures. Promotion requires the source version still to be active; rollback requires the promoted version still to be active.

Reversal configurations are immutable versions in a separate table. Legacy pending warnings retain their five-candle behavior and original legacy label. New warnings freeze their version and confirmation window. Promotion affects only subsequent warnings.

## Resource and release checks

The scheduler consumes at most 20 journal events per tick. Learning pauses at 90% of local read/write/request/storage safety limits, before the normal signal pipeline pauses. Failures in learning remain visible in `/status` without cancelling normal scanning/publication. Pruning never deletes operational journal events.

Run `npx tsx scripts/preview-learning.ts` for synthetic local review/report screenshots, and `npm run verify` plus `npm run worker:build`. Local previews and mocks do not establish actual Discord thread permissions or live delivery. Before normal-channel release, inspect a failure review and weekly report in the configured private test channel; confirm original prices/context, one reversal thread, retry deduplication, complete report attachment and no chart usage for learning messages. Preserve test mode until this inspection and existing historical/soak checks pass.

## Daily public recap

The first scheduler tick after midnight America/Phoenix queues the preceding local day's text-only recap to the summaries route, including zero-outcome days. Phoenix uses UTC-7 year-round. Activation starts the current day without advertising old history; the first recap labels its partial coverage. Missed days catch up one per tick. Learning backlog and pending source-callout deliveries delay finalization. Budget/learning pauses preserve the day cursor.

Daily outcomes reuse the existing classifier and commit atomically with learning resolution. Confirmed entries, setups, and reversal warnings are separate; ambiguous, unknown and unconfirmed results never count as wins. Only callouts with persisted delivery receipts contribute public totals; synthetic and recovery events are excluded. Calls made earlier can resolve today. Outcomes received after a recap was frozen appear once in a later recap, explicitly labeled delayed. Pending counts reflect publicly delivered unresolved learning samples at report time. Operational errors are disclosed; missing outcomes are never guessed.

Dated experiment records retain proposals, supersessions, manager-approved promotions and rollbacks. Daily shadow evidence shows both failed and successful calls that would have been filtered, plus retained outcomes. Failure observations, possible improvements, and approved changes are labeled distinctly; the recap does not claim that promotion demonstrates improved live performance. Existing human promotion controls remain in force. The recap reuses durable outbox deduplication, receipts, test-channel routing and production validation, and never fetches market data or renders charts.

## Daily predictive shadow model

Starting with this update, `learning_journal` retains every newly resolved sample, including ordinary successes and ambiguous, unknown and unconfirmed outcomes. Each row has the original callout, frozen features, terminal event (including available reference-price performance), resolution time, processing time and original shadow assignment. Update/delete triggers keep the journal immutable. Pending calls remain in `learning_pending`. Existing learning cursors are preserved: previously aggregated outcomes are not silently reconstructed into training samples. The detailed-case age/count limits still apply only to `learning_cases`.

On the first caught-up scheduler tick each Phoenix day, the learner fits deterministic L2-regularized logistic regression candidates. No new dependency, paid model, market-data request, browser or chart resource is used. Training reads at most 600 latest resolved samples per family and active rule version; the journal itself is retained under the existing storage-budget pause. Models separate family, market, timeframe and rule version. Direction, benchmark agreement, volume ratios, relative strength, ATR divided by price, and reward/risk use fixed bounded transforms and explicit missing-value flags. Replay/recovery and synthetic samples are excluded, and only success/failure labels train the classifier. Setups and reversals retain their distinct labels; these are not entry-profit models.

Only outcomes resolved and processed before the current Phoenix midnight are eligible. Samples are ordered by callout time; the latest 20% form a holdout. Training excludes samples whose resolution or observation time falls within one day of the first holdout callout, avoiding overlapping label windows and later-known labels. Fitting requires 60 training samples, 20 holdout samples, and at least 10 successes and 10 failures in training. Missing evidence produces an explicit report rather than a fabricated score. A candidate is the exact model tested on that holdout, without refitting on holdout labels. Daily holdouts may overlap across runs: these are descriptive diagnostics, not independent proof or promotion readiness.

Each daily model snapshot is immutable. Calls captured after its training time, under the matching original rules, retain its original score and a fixed experimental 0.5 retain/exclude assignment. Older backfilled calls receive no retrospective prediction. Retraining does not rescore pending calls. Scores are uncalibrated estimates and are not exposed as public confidence or win probabilities. Terminal reference-price performance is retained when available; fills, slippage-adjusted profit, and unobserved maximum favorable/adverse excursions are not invented.

`/learning report` and `/status` include the latest training evidence, sample requirements, holdout Brier score versus a training-frequency baseline (lower is better), and excluded failures versus excluded successes. The daily recap includes the dated model report when available and prospective shadow counts only for delivered calls, preserving the original model ID and separating uncertain outcomes. Late outcomes follow the existing recap rules. Model training/report snapshots commit atomically and run at most once per Phoenix day, including after restart; pauses and learning backlog defer training. Downtime does not invent models for missed days.

Predictive models are shadow-only. They cannot be passed to `/learning promote`, change signal levels or thresholds, suppress callouts, or bypass existing manager review, rollback, validation and private-channel soak controls. Those commands continue to manage the existing fixed-filter experiments. A future live model rollout requires a separately reviewed implementation and calibration evidence.
