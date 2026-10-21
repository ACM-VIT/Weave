import type { ReadmeSummaryArtifact } from './readmeSummary.v2.js';
export const FEED_SCHEMA_VERSION = 2 as const;

export type FeedSource = 'personalized' | 'trending' | 'popular' | 'fresh' | 'fallback';

export interface RecommendationEntry {
  repo_id: string;
  score: number;
  source: string;
  model_version: string;
  summary_id: string | null;
  generation_id?: string;
}

export interface RepositoryProjection {
  repo_id: string;
  full_name: string;
  owner_user_id: string | null;
  owner_profile_id: string | null;
  owner_profile_claimed_user_id: string | null;
  owner_bio: string | null;
  description: string | null;
  primary_language: string | null;
  languages: string[];
  topics: string[];
  star_count: number;
  fork_count: number;
  likes_count: number;
  comments_count: number;
  views_count: number;
  open_issues_count: number;
  summary_id: string | null;
  summary: string | null;
  summary_highlights: string[];
  summary_prompt_version: string | null;
  summary_model_version: string | null;
  summary_format_version: string | null;
  summary_source: 'generated' | 'description_fallback' | null;
  readme_digest?: ReadmeSummaryArtifact | null;
  readme_md: string | null;
  readme_source_path: string | null;
  readme_default_branch: string | null;
  readme_base_url: string | null;
  updated_at: string | null;
  viewer_reaction: 'like' | 'dislike' | null;
  viewer_saved: boolean;
  viewer_follows_owner: boolean;
  status: 'active' | 'archived' | 'deleted' | 'blocked';
}

export interface StoredServeItem extends RecommendationEntry {
  position: number;
  repository: RepositoryProjection;
}

export interface StoredServe {
  serve_id: string;
  feed_request_id: string;
  user_id: string;
  session_id: string;
  feed_version: bigint;
  generation_id: string | null;
  source: FeedSource;
  model_version: string | null;
  next_cursor: string | null;
  items: StoredServeItem[];
  created_at: string;
}

export interface CreateServeInput {
  feed_request_id: string;
  user_id: string;
  session_id: string;
  feed_version: bigint;
  generation_id: string | null;
  source: FeedSource;
  model_version: string | null;
  next_cursor: string | null;
  items: Array<RecommendationEntry & { position: number; repository: RepositoryProjection }>;
}

export interface FeedRequestV2 {
  feed_request_id: string;
  session_id: string;
  limit: number;
  cursor: string | null;
}

export interface FeedResponseV2 {
  serve_id: string;
  session_id: string;
  feed_version: string;
  source: FeedSource;
  model_version: string | null;
  items: StoredServeItem[];
  next_cursor: string | null;
}
