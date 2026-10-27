import type { RepositoryLanguageObservation } from '../services/repositoryLanguages.js';
import type { ReadmeSummaryArtifact } from './readmeSummary.v2.js';
export type RepositoryViewerReaction = 'like' | 'dislike' | null;

export type RepositoryStatus = 'active' | 'archived' | 'deleted' | 'blocked';

/**
 * Canonical, viewer-aware repository detail returned by
 * GET /api/v2/repositories/:repoId.
 *
 * The generated summary and complete README intentionally remain separate
 * fields. `selected_list_ids` contains source-qualified product List IDs backed
 * by the existing collection and legacy Board membership tables.
 */
export interface RepositoryDetailV2 extends RepositoryLanguageObservation {
  language_observed_at?: string | null;
  repo_id: string;
  github_id: string;
  full_name: string;
  owner: string;
  owner_github_id: string | null;
  name: string;
  url: string;
  status: RepositoryStatus;

  owner_user_id: string | null;
  owner_profile_id: string | null;
  owner_profile_claimed_user_id: string | null;
  owner_username: string | null;
  owner_display_name: string | null;
  owner_avatar_url: string | null;
  owner_bio: string | null;
  owner_profile_kind: string | null;
  viewer_follows_owner: boolean;

  description: string | null;
  summary_id: string | null;
  summary: string | null;
  summary_highlights: string[];
  summary_prompt_version: string | null;
  summary_model_version: string | null;
  summary_format_version: string | null;
  summary_source: 'generated' | 'description_fallback' | null;
  readme_digest?: ReadmeSummaryArtifact | null;
  /** Compatibility alias for clients predating the `readme_md` field. */
  readme: string | null;
  readme_md: string | null;
  /** Present on the opt-in metadata projection; null body aliases are deferred. */
  readme_available?: boolean;
  content_hash?: string | null;
  readme_source_path: string | null;
  readme_default_branch: string | null;
  readme_base_url: string | null;
  primary_language: string | null;
  languages: string[];
  topics: string[];

  star_count: number;
  fork_count: number;
  open_issues_count: number;
  likes_count: number;
  dislikes_count: number;
  saves_count: number;
  comments_count: number;
  views_count: number;

  content_version: number | null;
  created_at: string;
  updated_at: string;
  content_updated_at: string | null;
  source_updated_at: string | null;
  stats_observed_at: string | null;

  viewer_reaction: RepositoryViewerReaction;
  viewer_saved: boolean;
  selected_list_ids: string[];
}

/** Canonical README at one content identity, without viewer membership state. */
export interface RepositoryReadmeV2 {
  repo_id: string;
  content_version: number | null;
  content_hash: string | null;
  full_name: string;
  url: string;
  readme_available: boolean;
  readme_md: string | null;
  readme_source_path: string | null;
  readme_default_branch: string | null;
  readme_base_url: string | null;
}
