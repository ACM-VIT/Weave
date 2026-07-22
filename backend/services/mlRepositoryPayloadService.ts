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

/**
 * Projects the canonical ingestion record onto the strict ML v2 allowlist.
 * Backend persistence fields must never leak into an extra-forbid ML payload.
 */
export function buildMlRepositorySource(
  repository: RepositoryUpsert,
  contentHash: string,
): MlRepositorySource {
  return {
    github_id: repository.github_id,
    full_name: repository.full_name,
    url: repository.url,
    description: repository.description ?? '',
    primary_language: repository.primary_language?.trim() || 'Unknown',
    languages: [...(repository.languages ?? [])],
    topics: [...(repository.topics ?? [])],
    readme: repository.readme ?? null,
    ...(repository.readme_length !== undefined ? { readme_length: repository.readme_length } : {}),
    star_count: repository.star_count ?? 0,
    fork_count: repository.fork_count ?? 0,
    open_issues_count: repository.open_issues_count ?? 0,
    ...(repository.pushed_days_ago !== undefined ? { pushed_days_ago: repository.pushed_days_ago } : {}),
    ...(repository.delta_3d !== undefined ? { delta_3d: repository.delta_3d } : {}),
    ...(repository.delta_7d !== undefined ? { delta_7d: repository.delta_7d } : {}),
    ...(repository.delta_30d !== undefined ? { delta_30d: repository.delta_30d } : {}),
    ...(repository.mentionable_users_count !== undefined
      ? { mentionable_users_count: repository.mentionable_users_count } : {}),
    ...(repository.readme_to_codebase_ratio !== undefined
      ? { readme_to_codebase_ratio: repository.readme_to_codebase_ratio } : {}),
    ...(repository.recent_commits !== undefined
      ? { recent_commits: repository.recent_commits.map((value) => utcTimestamp(value)!) } : {}),
    ...(repository.created_at !== undefined ? { created_at: utcTimestamp(repository.created_at) } : {}),
    ...(repository.updated_at !== undefined ? { updated_at: utcTimestamp(repository.updated_at) } : {}),
    pushed_at: utcTimestamp(repository.pushed_at),
    ...(repository.discovery_category !== undefined
      ? { discovery_category: optionalText(repository.discovery_category) } : {}),
    ...(repository.discovery_band !== undefined
      ? { discovery_band: optionalText(repository.discovery_band) } : {}),
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
