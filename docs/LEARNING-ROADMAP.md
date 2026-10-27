# Learning roadmap

Updated October 20, 2026. These are deferred proposals, not implemented behavior or evidence of profitability. The implemented foundations are prospective-v1 scorecards, stronger manager promotion criteria, cached-candle execution measurements, and outcome-v1 diagnostics. See [learning behavior and validation](LEARNING.md).

The operating rule is: a failed call supplies an observation; a proposed fix earns consideration through better prospective results after missed winners and costs. Repeated failures can accelerate discovery and review, but cannot activate a rule by themselves. Keep model changes shadow-only until a separately reviewed rollout permits otherwise.

## Priority 1 — Probability calibration

- Compare reliability diagrams and uncertainty across predicted-probability bins; report log loss alongside Brier score and a constant-frequency baseline.
- Fit calibration on a chronological calibration set distinct from training and final evaluation, with overlapping label windows excluded. Compare the unchanged model against calibrated alternatives on future calls.
- Prerequisite: enough prospective outcomes and successes/failures in each bin. Merge or omit sparse bins rather than publish confident percentages.
- Acceptance: a published probability range corresponds to observed frequencies within reported uncertainty, improves proper scoring metrics prospectively, and does not leak future labels. Calibrated probabilities remain distinct from trade expectancy.
- Reference: [scikit-learn probability calibration](https://scikit-learn.org/stable/modules/calibration.html).

## Priority 1 — Broader chronological validation and multiple-testing controls

- Add rolling walk-forward evaluation across trending, sideways and volatile periods, with label-window purging, embargoes, and explicit source/data-version manifests.
- Expand the candidate registry to track every attempted feature set, threshold, calibration and abandoned variant. Allocate a cumulative testing budget or valid sequential-testing procedure before supporting repeated review windows.
- Current prospective-v1 makes one fixed-window inference per candidate and uses a one-sided 97.5% day-block bound for the two concurrent filters. This is not a lifetime familywise-error guarantee across an unlimited research program. Correlation spanning multiple days may require week or market-event blocks.
- Prerequisites: retained point-in-time data, sufficient independent market periods, and reviewed historical provenance. Daily holdouts that overlap are diagnostics, not independent confirmations.
- Acceptance: improvements repeat on untouched future periods, remain credible after accounting for tried variants, and cannot be selected through daily significance peeking.
- References: [TimeSeriesSplit and temporal gaps](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html), [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

## Priority 2 — Better context features

- Test session timing, opening/closing periods, volatility and trend regimes, ATR-normalized breakout distance, retest depth/duration, and liquidity/spread context where verified historical data exists.
- Add one small feature group at a time; compare with the simpler incumbent. Missing values remain explicit. Do not assume candle direction measures actual buyer/seller flow.
- Prerequisites: frozen feature definitions and adequate point-in-time history. News remains informational unless a separate rights, leakage and signal-impact review approves research integration.
- Acceptance: incremental prospective economic benefit and acceptable winner/coverage tradeoffs across cohorts, not merely a better fitted historical score. Sparse regimes cannot justify confident specialized models.

## Priority 2 — Post-promotion counterfactual monitoring

- Keep the former production filter evaluating silently after an approved fixed-filter promotion. Continue observing opportunities the new filter suppresses, even though they are not published.
- Freeze both policies, source universe, assignment times and execution assumptions. Extend candidate discovery rather than trying to reconstruct suppressed calls afterward.
- Prerequisites: a separately bounded monitoring path that can observe suppressed opportunities without changing watchlist mutations, idea capacity, existing public callouts or provider budgets.
- Acceptance: reports compare both policies on the same future opportunity set, including lost winners, and identify sustained degradation without automatic live changes. A manager can review an evidence-backed rollback.

## Priority 2 — Drift detection and adaptation

- Monitor recent versus longer-window prediction loss, net simulated benefit, feature distributions, unknown-data rates, signal retention and subgroup coverage.
- Distinguish provider outages/data revisions from genuine changes in relationships. Detect persistent degradation rather than punish a normal losing streak.
- Compare recent-window retraining, longer-window training and simple ensembles in shadow mode; do not erase older examples to make recent performance look better.
- Prerequisites: calibrated uncertainty, cumulative-testing controls and post-promotion counterfactual observations.
- Acceptance: a predefined drift trigger produces an auditable investigation or new candidate, has a measured false-alarm rate, and never alters live rules or stops by itself.

## Priority 3 — Economic modeling and label research

- Extend the execution model with verified liquidity constraints, directional borrow/funding costs, portfolio overlap and capacity, and explicit partial-exit assumptions. Stress-test costs and gap behavior rather than tune a favorable cost estimate.
- Study whether immediate invalidation, insufficient follow-through and favorable movement followed by reversal imply different entry versus exit hypotheses. Preserve observed failure labels even if a later rebound would have favored another policy.
- Prerequisites: complete observed price paths and licensed data for each added execution assumption. Missing observations stay unavailable; diagnostic tags remain descriptive, not causal.
- Acceptance: separately frozen entry/exit experiments improve net simulated outcomes on new calls without hiding drawdown or opportunity costs; no research result is labeled actual fills or realized returns.

## Priority 3 — Predictive-model rollout

- Design a separately reviewed manager-controlled activation and rollback interface for predictive models. Existing `/learning promote` remains limited to fixed filters.
- Require frozen feature/cost schemas, calibrated scores, prospective economic benefit, adequate cohort coverage, data-quality controls, resource headroom, and replay/private-channel validation.
- First compare bounded ranking or filtering with unchanged rules in shadow mode. Preserve original open-call levels, outcomes, assignments and complete audit history.
- Acceptance: the exact model and threshold proposed for activation are the ones evaluated; approval never silently refits or replaces the candidate. A production rollout preserves durable receipts, test routing and signal-only behavior and includes a documented rollback procedure.

## Implementation discipline

Each future experiment should state its hypothesis, baseline, frozen candidate, evaluation enrollment window, outcome horizon, minimum evidence, benefit metric, missed-winner budget, stopping rule and rollback review conditions before enrollment starts. Keep failed attempts visible. Append immutable major release entries and run `npm run verify` plus `npm run worker:build`. No idea here authorizes deployment, live activation, extra paid resources or manual release messages.
