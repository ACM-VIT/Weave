import { projectRepositoryLanguages } from './repositoryLanguages.js';
import type { TransactionSql } from 'postgres';
import { readmeSummaryProjection } from './readmeSummaryService.js';
import type { RepositoryDetailV2, RepositoryStatus } from '../contracts/repository.v2.js';
import { sqlClient } from '../db/index.js';

function optionalString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function isoTimestamp(value: unknown): string | null {
  if (value == null) return null;
  const parsed = new Date(value as string | number | Date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function mapRepositoryDetailRow(row: Record<string, unknown>): RepositoryDetailV2 {
  const createdAt = isoTimestamp(row.created_at);
  const updatedAt = isoTimestamp(row.updated_at);
  if (!createdAt || !updatedAt) throw new Error('Repository timestamps are invalid.');

  const status = String(row.status) as RepositoryStatus;
  const viewerReaction = row.viewer_reaction === 'like' || row.viewer_reaction === 'dislike'
    ? row.viewer_reaction
    : null;

  return {
    repo_id: String(row.repo_id),
    github_id: String(row.github_id),
    full_name: String(row.full_name),
    owner: String(row.owner),
    owner_github_id: optionalString(row.owner_github_id),
    name: String(row.name),
    url: String(row.url),
    status,

    owner_user_id: optionalString(row.owner_user_id),
    owner_profile_id: optionalString(row.owner_profile_id),
    owner_profile_claimed_user_id: optionalString(row.owner_profile_claimed_user_id),
    owner_username: optionalString(row.owner_username),
    owner_display_name: optionalString(row.owner_display_name),
    owner_avatar_url: optionalString(row.owner_avatar_url),
    owner_bio: optionalString(row.owner_bio),
    owner_profile_kind: optionalString(row.owner_profile_kind),
    viewer_follows_owner: row.viewer_follows_owner === true,

    description: optionalString(row.description),
    summary_id: optionalString(row.summary_id),
    summary: optionalString(row.summary),
    summary_highlights: stringArray(row.summary_highlights),
    summary_prompt_version: optionalString(row.summary_prompt_version),
    summary_model_version: optionalString(row.summary_model_version),
    summary_format_version: optionalString(row.summary_format_version),
    summary_source: row.summary_source === 'generated' || row.summary_source === 'description_fallback'
      ? row.summary_source : null,
    readme_digest: (row.readme_digest ?? null) as RepositoryDetailV2['readme_digest'],
    // Keep the legacy field until older mobile clients stop reading `readme`.
    readme: optionalString(row.readme_md),
    readme_md: optionalString(row.readme_md),
    readme_source_path: optionalString(row.readme_source_path),
    readme_default_branch: optionalString(row.readme_default_branch),
    readme_base_url: optionalString(row.readme_base_url),
    primary_language: optionalString(row.primary_language),
    ...projectRepositoryLanguages(row),
    topics: stringArray(row.topics),

    star_count: count(row.star_count),
    fork_count: count(row.fork_count),
    open_issues_count: count(row.open_issues_count),
    likes_count: count(row.likes_count),
    dislikes_count: count(row.dislikes_count),
    saves_count: count(row.saves_count),
    comments_count: count(row.comments_count),
    views_count: count(row.views_count),

    content_version: row.content_version == null ? null : count(row.content_version),
    created_at: createdAt,
    updated_at: updatedAt,
    content_updated_at: isoTimestamp(row.content_updated_at),
    source_updated_at: isoTimestamp(row.source_updated_at),
    stats_observed_at: isoTimestamp(row.stats_observed_at),

    viewer_reaction: viewerReaction,
    viewer_saved: row.viewer_saved === true,
    selected_list_ids: stringArray(row.selected_list_ids),
  };
}

// Optional summary/README metadata is read through JSON until migration 0024 is deployed.
// Missing provenance excludes legacy text so it can never appear as a concise Summary.
export async function getRepositoryDetails(
  viewerUserId: string,
  repositoryIds: string[],
  includeReadme = true,
  filters: { languages: string[]; topics: string[] } = { languages: [], topics: [] },
  sql: typeof sqlClient | TransactionSql = sqlClient,
): Promise<RepositoryDetailV2[]> {
  if (!repositoryIds.length) return [];
  const rows = await sql`
    SELECT
      repo.repo_id,repo.github_id,repo.full_name,repo.owner,repo.owner_github_id,
      repo.name,repo.url,repo.status,repo.created_at,repo.updated_at,
      ${sql.unsafe(readmeSummaryProjection('repo','content'))},
      content.description,CASE WHEN ${includeReadme} THEN content.readme ELSE NULL END AS readme_md,content.readme_source_path AS readme_source_path,
      content.readme_default_branch AS readme_default_branch,content.readme_base_url AS readme_base_url,content.primary_language,
      COALESCE(content.languages,'[]'::jsonb) AS languages,content.language_breakdown,content.language_total_size::float8 AS language_total_size,content.language_breakdown_complete,content.language_observed_at,
      content.content_version,content.updated_at AS content_updated_at,content.source_updated_at,
      summary.summary_id,summary.summary,summary.highlights AS summary_highlights,
      summary.prompt_version AS summary_prompt_version,
      summary.model_version AS summary_model_version,
      summary.format_version AS summary_format_version,summary.source AS summary_source,
      COALESCE(topic_values.topics,'[]'::jsonb) AS topics,
      COALESCE(stats.star_count,0) AS star_count,
      COALESCE(stats.fork_count,0) AS fork_count,
      COALESCE(stats.open_issues_count,0) AS open_issues_count,
      stats.observed_at AS stats_observed_at,
      COALESCE(engagement.likes_count,0) AS likes_count,
      COALESCE(engagement.dislikes_count,0) AS dislikes_count,
      COALESCE(engagement.saves_count,0) AS saves_count,
      COALESCE(engagement.comments_count,0) AS comments_count,
      COALESCE(engagement.views_count,0) AS views_count,
      reaction.reaction AS viewer_reaction,
      (saved.repo_id IS NOT NULL) AS viewer_saved,
      COALESCE(selected_lists.list_ids,'[]'::jsonb) AS selected_list_ids,
      owner_profile.profile_id AS owner_profile_id,
      owner_profile.claimed_by_user_id AS owner_user_id,
      owner_profile.claimed_by_user_id AS owner_profile_claimed_user_id,
      owner_profile.profile_kind AS owner_profile_kind,
      COALESCE(owner_user.username,owner_profile.handle) AS owner_username,
      COALESCE(owner_user.full_name,owner_profile.display_name,repo.owner) AS owner_display_name,
      COALESCE(owner_user.avatar_url,owner_profile.avatar_url) AS owner_avatar_url,
      owner_user.bio AS owner_bio,
      CASE
        WHEN owner_profile.claimed_by_user_id IS NOT NULL THEN owner_follow.following_id IS NOT NULL
        WHEN owner_profile.profile_id IS NOT NULL THEN external_owner_follow.profile_id IS NOT NULL
        ELSE false
      END AS viewer_follows_owner
    FROM app.repos repo
    LEFT JOIN app.repo_content content ON content.repo_id=repo.repo_id
    LEFT JOIN app.repo_engagement engagement ON engagement.repo_id=repo.repo_id
    LEFT JOIN LATERAL (
      SELECT snapshot.star_count,snapshot.fork_count,snapshot.open_issues_count,snapshot.observed_at
      FROM app.repo_stat_snapshots snapshot
      WHERE snapshot.repo_id=repo.repo_id
      ORDER BY snapshot.observed_at DESC
      LIMIT 1
    ) stats ON true
    LEFT JOIN LATERAL (
      SELECT card.summary_id,card.summary,to_jsonb(card)->'highlights' AS highlights,
        to_jsonb(card)->>'prompt_version' AS prompt_version,card.model_version,
        to_jsonb(card)->>'format_version' AS format_version,to_jsonb(card)->>'source' AS source
      FROM app.repo_card_summaries card
      WHERE card.repo_id=repo.repo_id AND card.active
        AND card.content_version=content.content_version
        AND to_jsonb(card)->>'source' IN ('generated','description_fallback')
      ORDER BY card.created_at DESC
      LIMIT 1
    ) summary ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(topic.slug ORDER BY topic.slug) AS topics
      FROM app.repo_topics repository_topic
      JOIN app.topics topic ON topic.topic_id=repository_topic.topic_id
      WHERE repository_topic.repo_id=repo.repo_id
    ) topic_values ON true
    LEFT JOIN LATERAL (
      SELECT profile.profile_id,profile.claimed_by_user_id,profile.handle,
        profile.display_name,profile.avatar_url,profile.profile_kind
      FROM app.social_profiles profile
      WHERE profile.provider='github' AND profile.status='active'
        AND (
          (repo.owner_github_id IS NOT NULL AND profile.provider_subject=repo.owner_github_id::text)
          OR (repo.owner_github_id IS NULL AND lower(profile.handle)=lower(repo.owner))
        )
      ORDER BY (profile.claimed_by_user_id IS NOT NULL) DESC,profile.created_at ASC
      LIMIT 1
    ) owner_profile ON true
    LEFT JOIN app.users owner_user ON owner_user.user_id=owner_profile.claimed_by_user_id
    LEFT JOIN app.follows owner_follow
      ON owner_follow.follower_id=${viewerUserId}::uuid
      AND owner_follow.following_id=owner_profile.claimed_by_user_id
    LEFT JOIN app.social_profile_follows external_owner_follow
      ON external_owner_follow.follower_id=${viewerUserId}::uuid
      AND external_owner_follow.profile_id=owner_profile.profile_id
      AND owner_profile.claimed_by_user_id IS NULL
    LEFT JOIN app.reactions reaction
      ON reaction.repo_id=repo.repo_id AND reaction.user_id=${viewerUserId}::uuid
    LEFT JOIN app.saves saved
      ON saved.repo_id=repo.repo_id AND saved.user_id=${viewerUserId}::uuid
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(selection.list_id ORDER BY selection.list_id) AS list_ids
      FROM (
        SELECT 'collection:' || collection.collection_id::text AS list_id
        FROM app.collection_repos membership
        JOIN app.board_collections collection ON collection.collection_id=membership.collection_id
        WHERE membership.repo_id=repo.repo_id AND collection.user_id=${viewerUserId}::uuid
        UNION ALL
        SELECT 'legacy-board:' || board.board_id::text AS list_id
        FROM app.board_repos membership
        JOIN app.boards board ON board.board_id=membership.board_id
        WHERE membership.repo_id=repo.repo_id AND board.user_id=${viewerUserId}::uuid
      ) selection
    ) selected_lists ON true
    WHERE repo.repo_id=ANY(${repositoryIds}::uuid[]) AND repo.status='active'
      AND (${filters.languages.length === 0} OR content.primary_language=ANY(${filters.languages}::text[]))
      AND (${filters.topics.length === 0} OR EXISTS (SELECT 1 FROM app.repo_topics rt JOIN app.topics t USING(topic_id)
        WHERE rt.repo_id=repo.repo_id AND t.slug=ANY(${filters.topics}::text[])))
  `;
  return rows.map(mapRepositoryDetailRow);
}

export async function getRepositoryDetail(viewerUserId: string, repositoryId: string): Promise<RepositoryDetailV2 | null> {
  return (await getRepositoryDetails(viewerUserId, [repositoryId]))[0] ?? null;
}
