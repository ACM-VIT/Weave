import { parseReadmeDigest, type ReadmeDigest } from '@/models/readme-digest';
import { apiV2 } from '@/api/client';
import type { RepositoryDetail, RepositoryReadmeDocument } from '@/models/repository';
import { mapRepositoryDetail } from '@/utils/repository-mapper';

export { repositoryDetailQueryKey, repositoryMetadataQueryKey, repositoryReadmeMetadataQueryKey, repositoryReadmeQueryKey } from '@/models/repository';

export type RepositoryApiPayload = {
  recommendation_source?: unknown;
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
  language_breakdown?: unknown;
  language_total_size?: unknown;
  language_breakdown_complete?: unknown;
  language_observed_at?: unknown;
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
  readme_digest?: unknown;
  readme_available?: unknown;
  content_hash?: unknown;
  readme_md?: unknown;
  readme?: unknown;
  readme_media_manifest?: unknown;
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

export type RepositoryReadmeSummary = {
  status: 'ready' | 'pending' | 'processing' | 'failed' | 'unavailable';
  content_version: number;
  summary: ReadmeDigest | null;
};

export async function fetchRepositoryReadmeSummary(repositoryId: string, token: string, signal?: AbortSignal): Promise<RepositoryReadmeSummary> {
  const payload=await apiV2<RepositoryReadmeSummary>(`/repositories/${encodeURIComponent(repositoryId)}/readme-summary`,{signal},token);
  if (!['ready','pending','processing','failed','unavailable'].includes(payload.status)
    || !Number.isInteger(payload.content_version) || payload.content_version<1) throw new Error('The README summary response was incomplete.');
  const summary=parseReadmeDigest(payload.summary);
  if (payload.status==='ready' && !summary) throw new Error('The README summary response was incomplete.');
  return {...payload,summary};
}

export async function fetchRepositoryMetadata(repositoryId: string, token: string, signal?: AbortSignal): Promise<RepositoryDetail> {
  const payload = await apiV2<RepositoryApiPayload>(`/repositories/${encodeURIComponent(repositoryId)}?projection=metadata`, {signal}, token);
  const repository = mapRepositoryDetail(payload);
  if (!repository || repository.id !== repositoryId) throw new Error('The repository response was incomplete.');
  return repository;
}

/** This endpoint never returns or patches viewer state. Preserve the canonical bytes exactly. */
export async function fetchRepositoryReadme(repositoryId: string, contentVersion: number, contentHash: string, token: string, signal?: AbortSignal): Promise<RepositoryReadmeDocument> {
  const payload = await apiV2<RepositoryApiPayload>(`/repositories/${encodeURIComponent(repositoryId)}/readme?content_version=${contentVersion}`, {signal}, token);
  if (payload.repo_id !== repositoryId || payload.content_version !== contentVersion || payload.content_hash !== contentHash
    || typeof payload.readme_available !== 'boolean' || (payload.readme_available ? typeof payload.readme_md !== 'string' : payload.readme_md !== null)) {
    throw new Error('The README response did not match this repository version.');
  }
  return {id:repositoryId,contentVersion,contentHash,hasReadme:payload.readme_available,readmeFull:payload.readme_md as string | null,
    fullName:typeof payload.full_name === 'string' ? payload.full_name : '',githubUrl:typeof payload.url === 'string' ? payload.url : '',
    readmeSourcePath:typeof payload.readme_source_path === 'string' ? payload.readme_source_path : null,
    readmeDefaultBranch:typeof payload.readme_default_branch === 'string' ? payload.readme_default_branch : null,
    readmeBaseUrl:typeof payload.readme_base_url === 'string' ? payload.readme_base_url : null};
}
