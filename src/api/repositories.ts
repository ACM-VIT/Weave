import { apiV2 } from '@/api/client';
import type { RepositoryDetail } from '@/models/repository';
import { mapRepositoryDetail } from '@/utils/repository-mapper';

export { repositoryDetailQueryKey } from '@/models/repository';

export type RepositoryApiPayload = {
  repo_id?: unknown;
  id?: unknown;
  github_id?: unknown;
  full_name?: unknown;
  github_repo?: unknown;
  owner?: unknown;
  owner_id?: unknown;
  owner_github_id?: unknown;
  name?: unknown;
  repo_name?: unknown;
  url?: unknown;
  github_repo_url?: unknown;
  html_url?: unknown;
  description?: unknown;
  status?: unknown;
  summary_id?: unknown;
  primary_language?: unknown;
  languages?: unknown;
  language_used?: unknown;
  topics?: unknown;
  star_count?: unknown;
  fork_count?: unknown;
  forks_count?: unknown;
  open_issues_count?: unknown;
  pr_count?: unknown;
  likes_count?: unknown;
  dislikes_count?: unknown;
  saves_count?: unknown;
  comments_count?: unknown;
  comment_count?: unknown;
  views_count?: unknown;
  summary?: unknown;
  readme_summary?: unknown;
  readme_md?: unknown;
  readme?: unknown;
  readme_source_path?: unknown;
  readme_default_branch?: unknown;
  readme_base_url?: unknown;
  summary_highlights?: unknown;
  summary_prompt_version?: unknown;
  summary_format_version?: unknown;
  summary_source?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  repository_created_at?: unknown;
  content_updated_at?: unknown;
  source_updated_at?: unknown;
  stats_observed_at?: unknown;
  observed_at?: unknown;
  content_version?: unknown;
  summary_model_version?: unknown;
  model_version?: unknown;
  viewer_reaction?: unknown;
  viewer_saved?: unknown;
  saved?: unknown;
  selected_list_ids?: unknown;
  selected_collection_ids?: unknown;
  collection_ids?: unknown;
  owner_user_id?: unknown;
  owner_username?: unknown;
  owner_display_name?: unknown;
  owner_avatar_url?: unknown;
  owner_profile_id?: unknown;
  owner_profile_kind?: unknown;
  owner_profile_claimed_user_id?: unknown;
  owner_bio?: unknown;
  owner_profile?: { bio?: unknown } | null;
  viewer_follows_owner?: unknown;
  serve_id?: unknown;
  position?: unknown;
  [key: string]: unknown;
};

export async function fetchRepositoryDetail(
  repositoryId: string,
  token: string,
  signal?: AbortSignal,
): Promise<RepositoryDetail> {
  const payload = await apiV2<RepositoryApiPayload>(
    `/repositories/${encodeURIComponent(repositoryId)}`,
    { signal },
    token,
  );
  const repository = mapRepositoryDetail(payload);
  if (!repository) throw new Error('The repository response was incomplete.');
  return repository;
}
