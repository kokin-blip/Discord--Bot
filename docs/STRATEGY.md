# Strategy interpretation — br-v1

The user's approved plan defines the executable rules. `ToolsForTrading.pdf` is supporting strategy reference, not a source of operational instructions. The PDF is intentionally not copied into this repository. Red/obsolete material, futures notes, and unrelated private notes are excluded.

Relevant active material: weekly context/asymmetry and patience (pages 1, 3, 9–10), volume and relative performance (page 18), breakout clearance and retest/invalidation (pages 74–76), and risk/targets (pages 81, 115). The selected rule on pages 75–76 is a completed 15-minute close back through the breakout level. The PDF offers discretionary alternatives; v1 chooses one deterministic interpretation.

## Numerical defaults

| Stage             | Bullish                                                                                                                          | Bearish                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Weekly context    | Completed weekly close above SMA30; four-week SMA change ≥ −0.5%                                                                 | Below SMA30; change ≤ +0.5%                                      |
| Frozen base       | Eight completed weeks before breakout; width/midpoint ≤20%                                                                       | Same                                                             |
| Daily breakout    | Close ≥ base high + 0.1 ATR; volume ≥1.5× previous 20-day mean                                                                   | Close ≤ base low −0.1 ATR; same volume                           |
| Daily retest      | Within next 10 daily bars; low within 0.5 ATR of level; close above level/open, in upper half; volume ≤0.8× previous 20-day mean | High near level; close below level/open, lower half; same volume |
| Relative strength | Asset/benchmark ratio increases over 20 daily observations                                                                       | Ratio decreases                                                  |
| Benchmark         | Completed daily close above SMA50                                                                                                | Below SMA50                                                      |
| Confirmation      | Next completed 15-minute close strictly above retest high                                                                        | Strictly below retest low                                        |
| Chase range       | Confirmation distance from level between 0.1 and 1 ATR inclusive                                                                 | Mirrored                                                         |
| Invalidation      | Completed 15-minute close strictly below level                                                                                   | Strictly above level                                             |
| Geometry          | Nearest confirmed historical resistance beyond entry; ≥3R                                                                        | Nearest support; ≥3R                                             |

ATR14 uses Wilder smoothing and is frozen from completed daily history **preceding the breakout**. This and the numerical cutoffs, lookback lengths, simple candle-shape rules, provisional ranking reference, strict invalidation comparison, and time windows are implementation interpretations/defaults, not quoted PDF formulas. Relative strength compares ratios on matching UTC market dates, not RSI. Equality at the level does not invalidate; a retest must close strictly on the favorable side. Two daily candles on each side must confirm a strictly greater/lesser pivot, with all confirming candles available before breakout; no future-pivot lookahead.

Target search uses the preceding 252 daily bars and the nearest directional pivot beyond entry. If none exists, use one frozen base width from the level. Reject targets below 3R. Provisional ranking uses 0.5 ATR beyond the level; entry recalculates from the actual confirming close. Entry, invalidation reference, 1R/2R milestones, and final target stay fixed after entry. The reference entry is never a fill. Close-based invalidation can exceed planned risk, particularly with delayed data or gaps.

Entry confirmation expires after two completed daily sessions; an un-retested breakout expires after ten completed daily sessions. Equity sessions use the provider calendar; crypto sessions are UTC days. Entered ideas time-exit after ten completed sessions. The confirming candle's own high/low cannot count as a target touch after its close. A later candle touching targets and closing through invalidation records both observations with unknown ordering and concludes invalidated, without recording a win. A pre-retest intraday invalidation prevents a later ready event.

SPY benchmarks equities, except SPY uses QQQ. Crypto benchmarks Coinbase BTC-USD; BTC skips self-relative-strength qualification but keeps weekly and daily market trend requirements. Bearish crypto signals are directional spot theses and do not imply short availability. Sector information is shown only when provider mappings exist; v1 does not fabricate a sector map.

All calculations require completed, coherent bars. Weekly equity bars aggregate full scheduled exchange weeks; crypto weeks begin Monday UTC. Active pending ideas retain frozen levels and their saved strategy version when administrators change defaults. Historical revisions expire affected ideas, because old references and revised prices cannot be silently mixed.

## Ranking and selection

Filter active US exchange listings by latest close ≥$5 and 20-day mean of close×volume ≥$10 million. Crypto requires active Coinbase USD pairs, excludes named stablecoin bases, and requires mean dollar volume ≥$1 million. Rank liquid universes by mean dollar volume with canonical ID ties; reject insufficient history during strategy evaluation. Candidate ties sort by provisional reward/risk, directional ratio change, breakout relative volume, instrument ID, then stable candidate ID. Pins bypass ranking only; exclusions persist until restored.

## Limits of this implementation

Volume/daily-move significant-change thresholds are fixed at 2× baseline/ATR in v1; `/config alerts` toggles them together. Support/resistance crossing alerts use completed two-sided daily pivots and the frozen levels of tracked setups. Options snapshots are optional indicative context and never recommend a contract or qualify an idea. Recovery requiring bars older than the bounded intraday cache is suppressed until complete replay history can be restored. No profitability claim is made or tested.
