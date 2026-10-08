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
];
export const currentRelease = releases.at(-1)!;
