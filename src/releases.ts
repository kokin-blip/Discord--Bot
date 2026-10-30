/** Append a new immutable entry for each major user-visible release. Minor fixes do not bump it. */
export interface BotRelease {
  id: string;
  title: string;
  changes: string[];
  addedCommands: string[];
  changedCommands: string[];
  removedCommands: string[];
}
export const releases: readonly BotRelease[] = [
  {
    id: '2026-10-07-learning-and-public-updates',
    title: 'Learning reviews and public bot updates',
    changes: [
      'Failed callouts receive a review in their discussion thread; reversal warnings now have a discussion thread.',
      'Weekly learning reports and silent experimental filters; promotion and rollback require an administrator or manager.',
      'Detailed learning examples retain failures and exceptional successes. Ordinary outcomes contribute aggregate counts.',
      'Major releases announce their changelog once. Watchlist changes announce the complete updated list.',
    ],
    addedCommands: [
      '/learning report',
      '/learning cases',
      '/learning experiments',
      '/learning promote id:<experiment>',
      '/learning rollback id:<experiment>',
    ],
    changedCommands: [
      '/status: learning diagnostics; long responses attach the complete JSON.',
      '/watch add/remove/restore: public update when the list changes.',
    ],
    removedCommands: [],
  },
  {
    id: '2026-10-08-candle-expansion',
    title: 'Candle range expansion alerts',
    changes: [
      'Daily and 15-minute alerts for candles at least 3× their preceding 10-day average range, with candle direction and volume context.',
      'Matching range and volume spikes combine into one alert; exact measurements appear in a discussion thread.',
      'Chart previews mark the call candle; text alerts continue when chart resources are unavailable.',
    ],
    addedCommands: [],
    changedCommands: [
      '/config alerts: range toggle and range_multiplier (1–10).',
      '/debug check: range diagnostics; /debug test tracker:range or combined.',
    ],
    removedCommands: [],
  },
  {
    id: '2026-10-08-r1-correctness-continuity',
    title: 'Release 1 · Correctness and continuity',
    changes: [
      'Pending ideas find retests under their original rules after strategy changes; refresh failures are isolated by market and crypto does not require an equity calendar.',
      'Level-cross alerts report actual crossing direction and prices. Delayed and obsolete entries are labeled historical.',
      'Previously published production calls continue receiving updates while new versions await review; replay records exact configuration and source evidence.',
    ],
    addedCommands: [],
    changedCommands: [
      '/config validation: attestations are retained by strategy/reversal version.',
    ],
    removedCommands: [],
  },
  {
    id: '2026-10-08-r2-efficiency-visibility',
    title: 'Release 2 · Efficiency and visibility',
    changes: [
      'Discovery and monitoring have separate cadences; provider work is bounded and intraday products retain independent progress.',
      'Frozen charts are cached and two daily render reservations are held for entries. Active ideas and journal lookups use indexes.',
      'Readable health, detector-backed explanations and delivery diagnostics; repeated delivery failures require operator review and retries preserve receipts.',
    ],
    addedCommands: [
      '/health',
      '/explain symbol:<symbol>',
      '/queue inspect',
      '/queue retry id:<event>',
      '/config show',
    ],
    changedCommands: ['/watch list page:<number>: paginated view and complete attachment.'],
    removedCommands: [],
  },
  {
    id: '2026-10-08-r3-decision-support',
    title: 'Release 3 · Decision support',
    changes: [
      'Active ideas include frozen-rule deadlines and data-quality pauses; digests summarize recent changes and optional personal symbol/event filters.',
      'Versioned terminal statistics retain ambiguous and unknown outcomes; benchmark context shows directional concentration without inventing sectors or correlation.',
      'Cached symbol/idea autocomplete and freshness/expiry/strike/indicative-spread checks for optional options context.',
      'Offline research simulator uses next-bar entries, explicit costs, gap-aware stops, conservative ambiguous bars and chronological holdout reporting; public signals remain separate from simulated fills.',
    ],
    addedCommands: [
      '/ideas active',
      '/digest personal:<boolean>',
      '/stats',
      '/context symbol:<optional>',
      '/follow add symbol:<symbol> type:<event>',
      '/follow remove symbol:<symbol>',
      '/follow list',
    ],
    changedCommands: [
      '/chart, /explain, /context, /follow add/remove: cached symbol autocomplete.',
      '/idea: active idea ID autocomplete.',
      '/status: readable health summary with full diagnostic attachment.',
    ],
    removedCommands: [],
  },
  {
    id: '2026-10-08-daily-callout-recap',
    title: 'Daily callout scorecard and learning recap',
    changes: [
      'Daily public summaries after midnight Phoenix time count right and wrong confirmed entries separately from setup qualifications and reversal confirmations.',
      'Ambiguous, unknown, unconfirmed and pending calls remain separate; only delivered callouts count, with delayed outcomes explicitly labeled.',
      'Learning updates report failure observations, shadow-filter tradeoffs and manager-approved changes without claiming unproven live improvement. Recaps are text-only and retry safely.',
    ],
    addedCommands: [],
    changedCommands: [],
    removedCommands: [],
  },
  {
    id: '2026-10-08-release-announcement-gif',
    title: 'Animated bot update announcements',
    changes: [
      'Every Bot updated announcement now embeds the Monkey Developer GIF to distinguish releases from ordinary posts.',
    ],
    addedCommands: [],
    changedCommands: [],
    removedCommands: [],
  },
  {
    id: '2026-10-09-news-intelligence-publication',
    title: 'Licensed informational news',
    changes: [
      'Optional cached news, explainable financial sentiment and reviewed sources; news never changes trading signals or learning promotions.',
      'Permission-gated daily Phoenix digests and bounded severe-event alerts use existing receipts and outbox, with all test-mode output routed to the private test channel.',
      'News is disabled by default. Source rights, credentials and a separate private-test soak and rollout review are required before production news.',
    ],
    addedCommands: [
      '/news latest [symbol]',
      '/news sentiment [symbol]',
      '/news sources',
      '/news status',
      '/news config enabled/marketaux/currents/gdelt/digest/alerts and reduced daily caps',
    ],
    changedCommands: [],
    removedCommands: [],
  },
  {
    id: '2026-10-09-news-validation-and-rollout',
    title: 'News validation and rollout review',
    changes: [
      'Private-test news diagnostics now track ingestion, duplicates, policy suppression, freshness, delivery failures and resource use.',
      'Explicit smoke checks share persistent provider quotas; uncertain attempts are never retried as smoke checks.',
      'Production news requires seven continuous healthy private-test days with live ingestion and delivery evidence, plus a manager review of accuracy and free-plan headroom. Offline fixtures cannot clear this gate.',
    ],
    addedCommands: [],
    changedCommands: [
      '/news status smoke:<boolean>: optionally queue bounded private-test checks; attach monitoring and review snapshot.',
      '/news config review_sha256/reviewed_mappings/false_mappings/reviewed_alerts/false_alerts/free_plan_verified: record a separate human rollout review.',
    ],
    removedCommands: [],
  },
  {
    id: '2026-10-11-daily-shadow-model',
    title: 'Daily learning journal and shadow model',
    changes: [
      'An immutable outcome journal now retains ordinary successes, failures and uncertain outcomes with frozen callout features and original shadow scores.',
      'Daily Phoenix training tests small regularized models on later observations, excluding overlapping outcome windows; insufficient evidence is reported explicitly.',
      'Daily recaps show model validation and prospective avoided-failure versus missed-success tradeoffs. Models remain experimental and cannot change live signals or bypass manager approval.',
    ],
    addedCommands: [],
    changedCommands: [
      '/learning report: daily shadow training evidence.',
      '/status: shadow learning diagnostics.',
    ],
    removedCommands: [],
  },
  {
    id: '2026-10-20-threshold-exit-review',
    title: 'Threshold indicator: stalled-trade exit reviews',
    changes: [
      'Optional four-market-hour stagnation reviews track confirmed ideas and member-registered standard long options, with frozen-ATR progress checkpoints and underlying range-contraction context.',
      'Breakeven, any profit, and bounded small losses above an entered stop can qualify; contract P&L uses explicitly labeled modified indicative quotes and entered fees, never executable or realized returns.',
      'Owner-controlled monitors, one alert per stall, one-hour snooze reminders, durable delivery receipts and forward observations use the updates route without charts. All threshold switches default off; no orders are placed.',
    ],
    addedCommands: [
      '/threshold add contract entry [quantity] [stop] [fees] [idea]',
      '/threshold edit id [entry] [quantity] [stop] [clear_stop] [fees]',
      '/threshold list',
      '/threshold show id',
      '/threshold snooze id',
      '/threshold stop id',
      '/threshold config [enabled] [ideas] [contracts] [hours] [progress_atr] [contract_loss_percent] [idea_loss_r]',
    ],
    changedCommands: [
      '/config show, /status, /health, /debug check: cached threshold settings, monitor eligibility, freshness, deferred work and errors.',
      '/watch list: includes symbols retained for active threshold contracts; watchlist announcements identify retained monitoring.',
    ],
    removedCommands: [],
  },
  {
    id: '2026-10-20-prospective-learning-scorecards',
    title: 'Prospective improvement scorecards and evidence-gated promotion',
    changes: [
      'Immutable prospective evaluations compare retained calls and missed winners, with cached-candle simulation, frozen costs, cohort checks and day-block uncertainty bounds.',
      'Recurring failure patterns permit faster shadow discovery and earlier evidence review; neither losses nor elapsed time can activate a filter automatically.',
      'Daily model research continues separately from frozen shadow evaluation candidates. Existing experiments need fresh evidence before manager-approved promotion.',
    ],
    addedCommands: [],
    changedCommands: [
      '/learning report, /learning experiments: prospective scorecards, simulation coverage, evidence tiers and readiness blockers.',
      '/learning promote: enforce finalized benefit, coverage and retention requirements before manager-approved rule changes.',
      '/status: fixed-filter and predictive-model evaluation diagnostics.',
    ],
    removedCommands: [],
  },
  {
    id: '2026-10-20-richer-learning-outcomes',
    title: 'Richer outcome diagnostics for shadow learning',
    changes: [
      'Immutable outcome diagnostics track completed-candle favorable/adverse excursions, time to extremes, terminal reasons and observation coverage without changing original outcome labels.',
      'Immediate invalidation, insufficient follow-through, favorable movement then reversal and near-chase-limit tags describe observed behavior; missing data and unknown candle ordering remain explicit.',
      'Diagnostic and simulated-execution cursors survive restarts and retain frozen source rules. Learning remains shadow-only unless a fixed filter passes evidence checks and receives manager approval.',
    ],
    addedCommands: [],
    changedCommands: [
      '/learning cases, /learning report: outcome diagnostics and coverage summaries alongside original results.',
      '/status: outcome-diagnostic availability; failure reviews and daily recap text include diagnostic summaries.',
    ],
    removedCommands: [],
  },
  {
    id: '2026-10-27-lifetime-scorecard-and-live-channels',
    title: 'Lifetime callout scorecard and automatic public channels',
    changes: [
      'Public lifetime correct/wrong entry totals include retained delivered history, with separate setup and reversal results and explicit uncertain outcomes and coverage.',
      'Automatically creates six public bot-post channels under Trading Bot; members use commands and discussion threads, and explicit channel overrides remain available.',
      'Live publication replaces private-test routing and historical-review/seven-day-soak blockers. Pause, permissions, data quality, resource limits, source rights and learning promotion review remain enforced.',
      'Historical messages and delivery receipts are preserved; legacy discussions continue in labeled public threads without replaying old entry signals.',
    ],
    addedCommands: ['/scorecard'],
    changedCommands: [
      '/config channels: optional overrides for automatically managed destinations.',
      '/config validation: optional historical research evidence, no publication gate.',
      '/status, /health, /debug check, /config show: live channel setup and scorecard coverage diagnostics.',
      '/news status: private-test smoke option removed; /news config: current live health and separate manager review without a private soak.',
    ],
    removedCommands: ['/debug test'],
  },
  {
    id: '2026-10-27-dedicated-entry-channel',
    title: 'Dedicated confirmed-entry channel',
    changes: [
      'Confirmed stock/ETF and crypto entry callouts now publish to an automatically created public #entries channel.',
      'Breakout and retest setup alerts stay in the equity/crypto ideas channels; milestones and exits stay in trade-updates. Entry details continue in the original idea discussion thread.',
      'Only unsent pending entries change destinations during upgrade; prior messages, delivery receipts, retry behavior and historical-entry labels are preserved.',
    ],
    addedCommands: [],
    changedCommands: [
      '/config channels: entries route available as an optional destination override.',
    ],
    removedCommands: [],
  },
  {
    id: '2026-10-29-entry-reliability-and-shadow-research',
    title: 'Entry reliability and separate shadow research',
    changes: [
      'Bounded, resumable history repair detects old holes behind fresh candles. Instrument-level evaluation and silent recovery protect fresh monitoring without replaying historical entries.',
      'Confirmed entries publish complete text before optional chart/options enrichment edits the same parent. Separate source, queue and first-delivery timing preserves immutable events and receipts.',
      'Three frozen daily-retest policies compare in isolated shadow cohorts with paired opportunities, explicit unknown coverage, execution delays, cost sensitivities and calendar-week uncertainty. Public entry rules and frozen production ideas remain unchanged.',
      'Local checkpointed historical collection and entry comparisons reserve a six-month holdout. New entry-filter promotion evidence requires a homogeneous execution-v2 cohort; legacy evidence and reversal reviews remain available.',
    ],
    addedCommands: ['/learning entries'],
    changedCommands: [
      '/status, /health, /debug check, /config show: repair progress, unresolved gaps, instrument evaluation health, timing coverage and research backlog.',
      '/explain symbol: confirmation blockers, feasible intervals and active frozen rules alongside current settings.',
      '/learning promote: new entry-filter evidence requires execution-v2; shadow entry-policy IDs cannot be activated.',
    ],
    removedCommands: [],
  },
];
export const currentRelease = releases.at(-1)!;
