export const INTERACTION_SCHEMA_VERSION = 2 as const;

export const INTERACTION_EVENT_TYPES = [
  'impression',
  'dwell',
  'readme_open',
  'github_open',
  'like',
  'unlike',
  'dislike',
  'undislike',
  'save',
  'unsave',
  'share',
  'follow',
  'unfollow',
] as const;

export type InteractionEventType = typeof INTERACTION_EVENT_TYPES[number];

export interface InteractionEventV2 {
  event_id: string;
  impression_event_id?: string | null;
  schema_version: typeof INTERACTION_SCHEMA_VERSION;
  session_id: string;
  serve_id: string | null;
  repo_id: string;
  position: number | null;
  event_type: InteractionEventType;
  dwell_ms: number | null;
  client_occurred_at: string;
  context: Record<string, unknown>;
}

export interface InteractionBatchV2 {
  events: InteractionEventV2[];
}

export interface InteractionResultV2 {
  event_id: string;
  status: 'accepted' | 'duplicate';
  feedback_version?: string;
}

export interface InteractionBatchResultV2 {
  accepted: number;
  duplicates: number;
  feed_version: string;
  results: InteractionResultV2[];
}

export const ML_RELEVANT_EVENTS = new Set<InteractionEventType>([
  'dwell', 'readme_open', 'github_open', 'like', 'unlike', 'dislike',
  'undislike', 'save', 'unsave', 'share',
]);

export const FEED_INVALIDATING_EVENTS = new Set<InteractionEventType>([
  'like', 'unlike', 'dislike', 'undislike', 'save', 'unsave',
]);
