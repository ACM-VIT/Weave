export const FEEDBACK_ACTIONS = {
  impression: 'impression',
  dwell: 'dwell',
  readmeOpen: 'readme_open',
  githubOpen: 'github_open',
  save: 'save',
  unsave: 'unsave',
  like: 'like',
  unlike: 'unlike',
  share: 'share',
  follow: 'follow',
  unfollow: 'unfollow',
  dislike: 'dislike',
  undislike: 'undislike',
} as const;

export type FeedbackAction = typeof FEEDBACK_ACTIONS[keyof typeof FEEDBACK_ACTIONS];

// A card must remain at least 50% visible for this long before we count
// an impression. This keeps quick passive swipes neutral.
export const IMPRESSION_VISIBILITY_THRESHOLD_MS = 1000;

// Dwell mirrors the ML service's accidental-scroll threshold.
export const DWELL_VISIBILITY_THRESHOLD_MS = 3000;
