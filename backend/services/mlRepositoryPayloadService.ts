import crypto from 'node:crypto';

import type { RepositoryUpsert } from '../contracts/ingestion.v2.js';
import type { MlRepositoryFeaturePatch, MlRepositorySource } from '../contracts/ml.v2.js';

function utcTimestamp(value: string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function optionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  return normalized || null;
}

export function normalizeCanonicalRepositoryReadme(
  repository: RepositoryUpsert,
): RepositoryUpsert {
  const readme = repository.readme == null || repository.readme.length === 0
    ? null
    : repository.readme;
  return {
    ...repository,
    readme,
    readme_source_path: readme === null ? null : repository.readme_source_path ?? null,
    readme_default_branch: readme === null ? null : repository.readme_default_branch ?? null,
    readme_base_url: readme === null ? null : repository.readme_base_url ?? null,
    readme_length: readme?.length ?? 0,
  };
}

export function repositoryContentHash(repository: RepositoryUpsert): string {
  const hashable = {
    ...buildMlRepositorySource(repository, 'pending'),
  } as Record<string, unknown>;
  for (const key of [
    'content_hash', 'star_count', 'fork_count', 'open_issues_count', 'pushed_days_ago',
    'delta_3d', 'delta_7d', 'delta_30d', 'mentionable_users_count', 'readme_length',
    'created_at', 'updated_at', 'pushed_at',
    'discovery_category', 'discovery_band',
  ]) delete hashable[key];
  // Commit history and README/code ratio are index-only ML fields. Keep them
  // in this hash until the strict refresh contract supports updating them.
  if (Array.isArray(hashable.languages)) hashable.languages = [...hashable.languages].sort();
  if (Array.isArray(hashable.topics)) {
    hashable.topics = hashable.topics.map((topic) => String(topic).toLowerCase()).sort();
  }
  return crypto.createHash('sha256').update(JSON.stringify(hashable)).digest('hex');
}

/**
 * Projects the canonical ingestion record onto the strict ML v2 allowlist.
 * Backend persistence fields must never leak into an extra-forbid ML payload.
 */
export function buildMlRepositorySource(
  repository: RepositoryUpsert,
  contentHash: string,
): MlRepositorySource {
  const canonical = normalizeCanonicalRepositoryReadme(repository);
  return {
    github_id: canonical.github_id,
    full_name: canonical.full_name,
    url: canonical.url,
    description: canonical.description ?? '',
    primary_language: canonical.primary_language?.trim() || 'Unknown',
    languages: [...(canonical.languages ?? [])],
    topics: [...(canonical.topics ?? [])],
    readme: canonical.readme ?? null,
    readme_source_path: canonical.readme_source_path ?? null,
    readme_default_branch: canonical.readme_default_branch ?? null,
    readme_base_url: canonical.readme_base_url ?? null,
    readme_length: canonical.readme_length ?? 0,
    star_count: canonical.star_count ?? 0,
    fork_count: canonical.fork_count ?? 0,
    open_issues_count: canonical.open_issues_count ?? 0,
    ...(canonical.pushed_days_ago !== undefined ? { pushed_days_ago: canonical.pushed_days_ago } : {}),
    ...(canonical.delta_3d !== undefined ? { delta_3d: canonical.delta_3d } : {}),
    ...(canonical.delta_7d !== undefined ? { delta_7d: canonical.delta_7d } : {}),
    ...(canonical.delta_30d !== undefined ? { delta_30d: canonical.delta_30d } : {}),
    ...(canonical.mentionable_users_count !== undefined
      ? { mentionable_users_count: canonical.mentionable_users_count } : {}),
    ...(canonical.readme_to_codebase_ratio !== undefined
      ? { readme_to_codebase_ratio: canonical.readme_to_codebase_ratio } : {}),
    ...(canonical.recent_commits !== undefined
      ? { recent_commits: canonical.recent_commits.map((value) => utcTimestamp(value)!) } : {}),
    ...(canonical.created_at !== undefined ? { created_at: utcTimestamp(canonical.created_at) } : {}),
    ...(canonical.updated_at !== undefined ? { updated_at: utcTimestamp(canonical.updated_at) } : {}),
    pushed_at: utcTimestamp(canonical.pushed_at),
    ...(canonical.discovery_category !== undefined
      ? { discovery_category: optionalText(canonical.discovery_category) } : {}),
    ...(canonical.discovery_band !== undefined
      ? { discovery_band: optionalText(canonical.discovery_band) } : {}),
    content_hash: contentHash,
  };
}

export function buildMlRepositoryFeaturePatch(
  repository: RepositoryUpsert,
): MlRepositoryFeaturePatch {
  return {
    star_count: repository.star_count ?? 0,
    fork_count: repository.fork_count ?? 0,
    open_issues_count: repository.open_issues_count ?? 0,
    ...(repository.pushed_days_ago !== undefined ? { pushed_days_ago: repository.pushed_days_ago } : {}),
    ...(repository.delta_3d !== undefined ? { delta_3d: repository.delta_3d } : {}),
    ...(repository.delta_7d !== undefined ? { delta_7d: repository.delta_7d } : {}),
    ...(repository.delta_30d !== undefined ? { delta_30d: repository.delta_30d } : {}),
    ...(repository.mentionable_users_count !== undefined
      ? { mentionable_users_count: repository.mentionable_users_count } : {}),
    ...(repository.updated_at !== undefined ? { updated_at: utcTimestamp(repository.updated_at) } : {}),
    pushed_at: utcTimestamp(repository.pushed_at),
    ...(repository.discovery_category !== undefined
      ? { discovery_category: optionalText(repository.discovery_category) } : {}),
    ...(repository.discovery_band !== undefined
      ? { discovery_band: optionalText(repository.discovery_band) } : {}),
  };
}
