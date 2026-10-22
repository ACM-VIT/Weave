import type { InteractionEventType } from './interactions.v2.js';

export const ML_SCHEMA_VERSION = 2 as const;
export const ML_DESCRIPTION_FALLBACK_MODEL_VERSION = 'repository-description-fallback-v1' as const;

export interface MlRecommendationRequest {
  schema_version: typeof ML_SCHEMA_VERSION;
  generation_id: string;
  user_id: string;
  feed_version: number;
  limit: number;
  exclude_repo_ids: string[];
  social_repo_ids?: string[];
  context: { cold_start: boolean; locale?: string };
}

export interface MlRecommendationItem {
  repo_id: string;
  score: number;
  source: string;
}

export interface MlRecommendationResponse {
  schema_version: typeof ML_SCHEMA_VERSION;
  generation_id: string;
  user_id: string;
  feed_version: number;
  model_version: string;
  embedding_version: string;
  items: MlRecommendationItem[];
}

export interface MlFeedbackEvent {
  event_id: string;
  user_id: string;
  repo_id: string;
  feedback_version: string;
  event_type: InteractionEventType;
  dwell_ms: number | null;
  occurred_at: string;
}

export interface MlFeedbackBatch {
  schema_version: typeof ML_SCHEMA_VERSION;
  events: MlFeedbackEvent[];
}

export interface MlOnboardingJob {
  job_id: string;
  user_id: string;
  profile_version: number;
  profile: Record<string, unknown>;
}

export interface MlRepositorySource {
  github_id?: string | null;
  full_name: string;
  url?: string | null;
  description: string;
  primary_language: string;
  languages: string[];
  topics: string[];
  readme?: string | null;
  readme_source_path?: string | null;
  readme_default_branch?: string | null;
  readme_base_url?: string | null;
  readme_length?: number;
  star_count: number;
  fork_count: number;
  open_issues_count: number;
  pushed_days_ago?: number;
  delta_3d?: number;
  delta_7d?: number;
  delta_30d?: number;
  mentionable_users_count?: number;
  readme_to_codebase_ratio?: number;
  recent_commits?: string[];
  created_at?: string | null;
  updated_at?: string | null;
  pushed_at?: string | null;
  discovery_category?: string | null;
  discovery_band?: string | null;
  content_hash: string;
}

export interface MlRepositoryIndexJob {
  job_id: string;
  repo_id: string;
  content_version: number;
  repository: MlRepositorySource;
}

export type MlRepositoryIndexStatus = 'applied' | 'duplicate' | 'current';

export interface MlRepositoryCardSummary {
  summary: string;
  highlights: string[];
  prompt_version: string;
  model_version: string;
  format_version: string;
  source: 'generated' | 'description_fallback';
}

export interface MlRepositoryIndexResponse {
  schema_version: typeof ML_SCHEMA_VERSION;
  accepted: true;
  status: MlRepositoryIndexStatus;
  job_id: string;
  repo_id: string;
  content_version: number;
  embedding_version: string;
  card_summary: MlRepositoryCardSummary;
}

export interface MlRepositoryFeaturePatch {
  star_count?: number;
  fork_count?: number;
  open_issues_count?: number;
  pushed_days_ago?: number;
  delta_3d?: number;
  delta_7d?: number;
  delta_30d?: number;
  mentionable_users_count?: number;
  updated_at?: string | null;
  pushed_at?: string | null;
  discovery_category?: string | null;
  discovery_band?: string | null;
}

export interface MlRepositoryRefreshJob {
  job_id: string;
  repo_id: string;
  feature_version: number;
  features: MlRepositoryFeaturePatch;
}

export interface DeliveryResult {
  /** Transport-only classification; never changes retry or acceptance policy. */
  failure_kind?: 'timeout';
  accepted: boolean;
  retryable: boolean;
  status_code: number;
  detail?: string;
  retry_after_ms?: number;
  response_body?: unknown;
}
