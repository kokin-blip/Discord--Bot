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
];
export const currentRelease = releases.at(-1)!;
