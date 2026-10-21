import type {
  CreateServeInput,
  RepositoryProjection,
  StoredServe,
  StoredServeItem,
} from '../contracts/feed.v2.js';
import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import { sqlClient } from '../db/index.js';

function projection(row: Record<string, unknown>): RepositoryProjection {
  return {
    repo_id: String(row.repo_id),
    full_name: String(row.full_name),
    owner_user_id: row.owner_user_id == null ? null : String(row.owner_user_id),
    owner_profile_id: row.owner_profile_id == null ? null : String(row.owner_profile_id),
    owner_profile_claimed_user_id: row.owner_profile_claimed_user_id == null
      ? null : String(row.owner_profile_claimed_user_id),
    owner_bio: row.owner_bio == null ? null : String(row.owner_bio),
    description: row.description == null ? null : String(row.description),
    primary_language: row.primary_language == null ? null : String(row.primary_language),
    languages: Array.isArray(row.languages) ? row.languages.map(String) : [],
    topics: Array.isArray(row.topics) ? row.topics.map(String) : [],
    star_count: Number(row.star_count ?? 0),
    fork_count: Number(row.fork_count ?? 0),
    likes_count: Number(row.likes_count ?? 0),
    comments_count: Number(row.comments_count ?? 0),
    views_count: Number(row.views_count ?? 0),
    open_issues_count: Number(row.open_issues_count ?? 0),
    summary_id: row.summary_id == null ? null : String(row.summary_id),
    summary: row.summary == null ? null : String(row.summary),
    readme_md: row.readme == null ? null : String(row.readme),
    updated_at: row.updated_at == null ? null : String(row.updated_at),
    viewer_reaction: row.viewer_reaction === 'like' || row.viewer_reaction === 'dislike'
      ? row.viewer_reaction : null,
    viewer_saved: Boolean(row.viewer_saved),
    viewer_follows_owner: Boolean(row.viewer_follows_owner),
    status: row.status as RepositoryProjection['status'],
  };
}

export class PostgresFeedPersistence implements FeedPersistencePort {
  async recordGenerationAttempt(input: Parameters<NonNullable<FeedPersistencePort['recordGenerationAttempt']>>[0]): Promise<void> {
    await sqlClient`
      INSERT INTO telemetry.generation_attempts (
        generation_id,user_id,feed_version,mode,status,latency_ms,result_count,error_code
      ) VALUES (
        ${input.generation_id}::uuid,${input.user_id}::uuid,${input.feed_version.toString()}::bigint,
        ${input.mode},${input.status},${input.latency_ms},${input.result_count},${input.error_code ?? null}
      ) ON CONFLICT (generation_id) DO NOTHING
    `;
  }

  async getFeedVersion(userId: string): Promise<bigint> {
    const rows = await sqlClient`SELECT feed_version FROM app.user_feed_state WHERE user_id=${userId}::uuid`;
    if (rows.length) return BigInt(rows[0].feed_version);
    const inserted = await sqlClient`
      INSERT INTO app.user_feed_state (user_id) VALUES (${userId}::uuid)
      ON CONFLICT (user_id) DO NOTHING RETURNING feed_version
    `;
    if (inserted.length) return BigInt(inserted[0].feed_version);
    const current = await sqlClient`SELECT feed_version FROM app.user_feed_state WHERE user_id=${userId}::uuid`;
    if (!current.length) throw new Error('User feed state is unavailable.');
    return BigInt(current[0].feed_version);
  }

  async listExcludedRepositoryIds(userId: string, sessionId: string | undefined, limit: number): Promise<string[]> {
    const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), 500)) : 0;
    if (!boundedLimit) return [];
    const rows = await sqlClient`
      WITH exposures AS (
        SELECT item.repo_id,serve.created_at AS observed_at,0 AS priority
        FROM telemetry.feed_serves serve
        JOIN telemetry.feed_serve_items item ON item.serve_id=serve.serve_id
        WHERE serve.user_id=${userId}::uuid AND serve.session_id=${sessionId ?? null}::uuid
        UNION ALL
        SELECT repo_id,last_event_at AS observed_at,1 AS priority
        FROM telemetry.user_repo_engagement WHERE user_id=${userId}::uuid
      )
      SELECT repo_id FROM exposures GROUP BY repo_id
      ORDER BY min(priority),max(observed_at) DESC,repo_id LIMIT ${boundedLimit}
    `;
    return rows.map(row => String(row.repo_id));
  }

  async listFollowedRepositoryIds(userId: string, limit: number): Promise<string[]> {
    const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 0;
    const boundedLimit = Math.max(0, Math.min(normalizedLimit, 500));
    if (boundedLimit === 0) return [];
    const rows = await sqlClient`
      WITH followed_repositories AS (
        SELECT repo.repo_id,follow.created_at AS followed_at,repo.updated_at
        FROM app.follows follow
        JOIN app.users followed ON followed.user_id=follow.following_id
        JOIN app.repos repo
          ON repo.owner_github_id::text=followed.github_id
        WHERE follow.follower_id=${userId}::uuid
          AND followed.status='active'
          AND followed.github_identity_verified_at IS NOT NULL
          AND followed.github_id IS NOT NULL
          AND repo.status='active'

        UNION ALL

        SELECT repo.repo_id,external_follow.created_at AS followed_at,repo.updated_at
        FROM app.social_profile_follows external_follow
        JOIN app.social_profiles profile
          ON profile.profile_id=external_follow.profile_id
        JOIN app.repos repo
          ON (
            (
              repo.owner_github_id IS NOT NULL
              AND profile.provider_subject=repo.owner_github_id::text
            )
            OR (
              repo.owner_github_id IS NULL
              AND lower(repo.owner)=lower(profile.handle)
            )
          )
        WHERE external_follow.follower_id=${userId}::uuid
          AND profile.provider='github'
          AND profile.status='active'
          AND profile.claimed_by_user_id IS NULL
          AND repo.status='active'
      )
      SELECT repo_id,max(followed_at) AS followed_at,max(updated_at) AS updated_at
      FROM followed_repositories
      GROUP BY repo_id
      ORDER BY max(followed_at) DESC,max(updated_at) DESC,repo_id
      LIMIT ${boundedLimit}
    `;
    return rows.map((row) => String(row.repo_id));
  }

  async getServeByRequest(userId: string, feedRequestId: string): Promise<StoredServe | null> {
    const serves = await sqlClient`
      SELECT * FROM telemetry.feed_serves
      WHERE user_id = ${userId}::uuid AND feed_request_id = ${feedRequestId}::uuid
      LIMIT 1
    `;
    if (serves.length === 0) return null;
    const serve = serves[0];
    const rows = await sqlClient`
      SELECT item.*, repo.full_name, repo.updated_at, content.description, content.primary_language, content.languages, content.readme,
             COALESCE(topic_values.topics, '[]'::jsonb) AS topics,
             stats.star_count, stats.fork_count, stats.open_issues_count,
             engagement.likes_count, engagement.comments_count, engagement.views_count,
             summary.summary, reaction.reaction AS viewer_reaction,
             (saved.repo_id IS NOT NULL) AS viewer_saved,
             social_profile.claimed_by_user_id AS owner_user_id,
             social_profile.profile_id AS owner_profile_id,
             social_profile.claimed_by_user_id AS owner_profile_claimed_user_id,
             owner_user.bio AS owner_bio,
             CASE WHEN social_profile.claimed_by_user_id IS NOT NULL
               THEN viewer_follow.following_id IS NOT NULL
               ELSE external_follow.profile_id IS NOT NULL
             END AS viewer_follows_owner,
             repo.status
      FROM telemetry.feed_serve_items item
      JOIN app.repos repo ON repo.repo_id = item.repo_id
      LEFT JOIN LATERAL (
        SELECT profile.profile_id,profile.claimed_by_user_id
        FROM app.social_profiles profile
        WHERE profile.provider='github' AND profile.status='active'
          AND (
            (
              repo.owner_github_id IS NOT NULL
              AND profile.provider_subject=repo.owner_github_id::text
            )
            OR (
              repo.owner_github_id IS NULL
              AND lower(profile.handle)=lower(repo.owner)
            )
          )
        ORDER BY (profile.claimed_by_user_id IS NOT NULL) DESC,profile.created_at ASC
        LIMIT 1
      ) social_profile ON true
      LEFT JOIN app.users owner_user ON owner_user.user_id=social_profile.claimed_by_user_id
      LEFT JOIN app.follows viewer_follow
        ON viewer_follow.follower_id=${String(serve.user_id)}::uuid
       AND viewer_follow.following_id=social_profile.claimed_by_user_id
      LEFT JOIN app.social_profile_follows external_follow
        ON external_follow.follower_id=${String(serve.user_id)}::uuid
       AND external_follow.profile_id=social_profile.profile_id
       AND social_profile.claimed_by_user_id IS NULL
      LEFT JOIN app.repo_content content ON content.repo_id = repo.repo_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(topic.slug ORDER BY topic.slug) AS topics
        FROM app.repo_topics rt JOIN app.topics topic ON topic.topic_id = rt.topic_id
        WHERE rt.repo_id = repo.repo_id
      ) topic_values ON true
      LEFT JOIN LATERAL (
        SELECT star_count, fork_count, open_issues_count FROM app.repo_stat_snapshots snapshot
        WHERE snapshot.repo_id = repo.repo_id ORDER BY observed_at DESC LIMIT 1
      ) stats ON true
      LEFT JOIN app.repo_engagement engagement ON engagement.repo_id = repo.repo_id
      LEFT JOIN app.repo_card_summaries summary ON summary.summary_id = item.summary_id
      LEFT JOIN app.reactions reaction ON reaction.repo_id=repo.repo_id AND reaction.user_id=${String(serve.user_id)}::uuid
      LEFT JOIN app.saves saved ON saved.repo_id=repo.repo_id AND saved.user_id=${String(serve.user_id)}::uuid
      WHERE item.serve_id = ${serve.serve_id}::uuid ORDER BY item.position
    `;
    const items: StoredServeItem[] = rows.map((row) => ({
      position: Number(row.position), repo_id: String(row.repo_id), score: Number(row.score ?? 0),
      source: String(row.source), model_version: row.model_version == null ? '' : String(row.model_version),
      summary_id: row.summary_id == null ? null : String(row.summary_id), repository: projection(row),
    }));
    return {
      serve_id: String(serve.serve_id), feed_request_id: String(serve.feed_request_id), user_id: String(serve.user_id),
      session_id: String(serve.session_id), feed_version: BigInt(serve.feed_version),
      generation_id: serve.generation_id == null ? null : String(serve.generation_id),
      source: serve.source as StoredServe['source'], model_version: serve.model_version == null ? null : String(serve.model_version),
      next_cursor: serve.next_cursor == null ? null : String(serve.next_cursor),
      items, created_at: new Date(serve.created_at as string).toISOString(),
    };
  }

  async createServe(input: CreateServeInput): Promise<StoredServe> {
    if (input.items.length > 100) throw new Error('A feed serve cannot contain more than 100 items.');
    const created = await sqlClient.begin(async (tx) => {
      const headers = await tx`
        INSERT INTO telemetry.feed_serves (
          feed_request_id,user_id,session_id,feed_version,generation_id,source,model_version,next_cursor
        ) VALUES (
          ${input.feed_request_id}::uuid,${input.user_id}::uuid,${input.session_id}::uuid,
          ${input.feed_version.toString()}::bigint,${input.generation_id}::uuid,${input.source},${input.model_version},${input.next_cursor}
        ) ON CONFLICT (feed_request_id) DO NOTHING RETURNING serve_id,created_at
      `;
      if (!headers.length) return null;
      const header = headers[0];
      if (input.items.length) {
        const items = input.items.map(item => ({ position: item.position,repo_id: item.repo_id,score: item.score,
          source: item.source,model_version: item.model_version,summary_id: item.summary_id }));
        await tx`
          INSERT INTO telemetry.feed_serve_items (serve_id,position,repo_id,score,source,model_version,summary_id)
          SELECT ${String(header.serve_id)}::uuid,position,repo_id,score,source,model_version,summary_id
          FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS item(
            position integer,repo_id uuid,score double precision,source text,model_version text,summary_id uuid
          )
        `;
      }
      return header;
    });
    if (!created || input.items.some(item => item.summary_id !== item.repository.summary_id)) {
      const replay = await this.getServeByRequest(input.user_id, input.feed_request_id);
      if (!replay) throw new Error('Serve was not persisted.');
      return replay;
    }
    // Creation uses the canonical projections already hydrated for this serve.
    // Replays/conflicts read current mutable product fields from storage.
    return {
      ...input,serve_id: String(created.serve_id),created_at: new Date(created.created_at as string).toISOString(),
      items: [...input.items].sort((a,b) => a.position-b.position).map(item => ({
        position: item.position,repo_id: item.repo_id,score: item.score,source: item.source,
        model_version: item.model_version,summary_id: item.summary_id,repository: item.repository,
      })),
    };
  }

  async listActiveRepositories(repoIds: string[], viewerUserId?: string): Promise<RepositoryProjection[]> {
    if (repoIds.length === 0) return [];
    const rows = await sqlClient`
      SELECT repo.repo_id, repo.full_name, repo.status, repo.updated_at, content.description, content.primary_language, content.languages, content.readme,
             COALESCE(topic_values.topics, '[]'::jsonb) AS topics,
             COALESCE(stats.star_count, 0) AS star_count, COALESCE(stats.fork_count, 0) AS fork_count, COALESCE(stats.open_issues_count, 0) AS open_issues_count,
             COALESCE(engagement.likes_count, 0) AS likes_count, COALESCE(engagement.comments_count, 0) AS comments_count, COALESCE(engagement.views_count, 0) AS views_count,
             summary.summary_id, summary.summary, reaction.reaction AS viewer_reaction,
             (saved.repo_id IS NOT NULL) AS viewer_saved,
             social_profile.claimed_by_user_id AS owner_user_id,
             social_profile.profile_id AS owner_profile_id,
             social_profile.claimed_by_user_id AS owner_profile_claimed_user_id,
             owner_user.bio AS owner_bio,
             CASE WHEN social_profile.claimed_by_user_id IS NOT NULL
               THEN viewer_follow.following_id IS NOT NULL
               ELSE external_follow.profile_id IS NOT NULL
             END AS viewer_follows_owner
      FROM app.repos repo
      LEFT JOIN LATERAL (
        SELECT profile.profile_id,profile.claimed_by_user_id
        FROM app.social_profiles profile
        WHERE profile.provider='github' AND profile.status='active'
          AND (
            (
              repo.owner_github_id IS NOT NULL
              AND profile.provider_subject=repo.owner_github_id::text
            )
            OR (
              repo.owner_github_id IS NULL
              AND lower(profile.handle)=lower(repo.owner)
            )
          )
        ORDER BY (profile.claimed_by_user_id IS NOT NULL) DESC,profile.created_at ASC
        LIMIT 1
      ) social_profile ON true
      LEFT JOIN app.users owner_user ON owner_user.user_id=social_profile.claimed_by_user_id
      LEFT JOIN app.follows viewer_follow
        ON viewer_follow.follower_id=${viewerUserId ?? null}::uuid
       AND viewer_follow.following_id=social_profile.claimed_by_user_id
      LEFT JOIN app.social_profile_follows external_follow
        ON external_follow.follower_id=${viewerUserId ?? null}::uuid
       AND external_follow.profile_id=social_profile.profile_id
       AND social_profile.claimed_by_user_id IS NULL
      LEFT JOIN app.repo_content content ON content.repo_id=repo.repo_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(topic.slug ORDER BY topic.slug) AS topics
        FROM app.repo_topics rt JOIN app.topics topic ON topic.topic_id=rt.topic_id WHERE rt.repo_id=repo.repo_id
      ) topic_values ON true
      LEFT JOIN LATERAL (
        SELECT star_count,fork_count,open_issues_count FROM app.repo_stat_snapshots snapshot
        WHERE snapshot.repo_id=repo.repo_id ORDER BY observed_at DESC LIMIT 1
      ) stats ON true
      LEFT JOIN app.repo_engagement engagement ON engagement.repo_id = repo.repo_id
      LEFT JOIN app.repo_card_summaries summary ON summary.repo_id=repo.repo_id AND summary.active
      LEFT JOIN app.reactions reaction ON reaction.repo_id=repo.repo_id AND reaction.user_id=${viewerUserId ?? null}::uuid
      LEFT JOIN app.saves saved ON saved.repo_id=repo.repo_id AND saved.user_id=${viewerUserId ?? null}::uuid
      WHERE repo.repo_id = ANY(${repoIds}::uuid[]) AND repo.status='active'
    `;
    return rows.map((row) => projection(row));
  }

  async getTrendingFallback(
    limit: number,
    excludeRepoIds: string[],
    viewerUserId?: string,
  ): Promise<RepositoryProjection[]> {
    const rows = await sqlClient`
      SELECT item.repo_id FROM app.trending_snapshot_items item
      JOIN app.trending_snapshots snapshot ON snapshot.snapshot_id=item.snapshot_id
      JOIN app.repos repo ON repo.repo_id=item.repo_id
      WHERE snapshot.complete AND snapshot.active AND repo.status='active'
        AND NOT (item.repo_id = ANY(${excludeRepoIds}::uuid[]))
      ORDER BY snapshot.activated_at DESC, item.position ASC LIMIT ${limit}
    `;
    const ids = rows.map((row) => String(row.repo_id));
    const projections = await this.listActiveRepositories(ids, viewerUserId);
    const byId = new Map(projections.map((repo) => [repo.repo_id, repo]));
    return ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  }

  async hasServe(userId: string, feedRequestId: string): Promise<boolean> {
    return (await this.getServeByRequest(userId, feedRequestId)) !== null;
  }
}
