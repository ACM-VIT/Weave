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
    const rows = await sqlClient`
      INSERT INTO app.user_feed_state (user_id) VALUES (${userId}::uuid)
      ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING feed_version
    `;
    return BigInt(rows[0].feed_version);
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
             owner_profile.user_id AS owner_user_id,
             (viewer_follow.following_id IS NOT NULL) AS viewer_follows_owner,
             repo.status
      FROM telemetry.feed_serve_items item
      JOIN app.repos repo ON repo.repo_id = item.repo_id
      LEFT JOIN LATERAL (
        SELECT owner_user.user_id
        FROM app.users owner_user
        WHERE owner_user.status='active'
          AND owner_user.github_identity_verified_at IS NOT NULL
          AND owner_user.github_id IS NOT NULL
          AND owner_user.github_handle IS NOT NULL
          AND lower(owner_user.github_handle)=lower(repo.owner)
        ORDER BY owner_user.github_identity_verified_at DESC,owner_user.user_id ASC
        LIMIT 1
      ) owner_profile ON true
      LEFT JOIN app.follows viewer_follow
        ON viewer_follow.follower_id=${String(serve.user_id)}::uuid
       AND viewer_follow.following_id=owner_profile.user_id
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
    await sqlClient.begin(async (tx) => {
      const existing = await tx`
        SELECT serve_id FROM telemetry.feed_serves
        WHERE user_id=${input.user_id}::uuid AND feed_request_id=${input.feed_request_id}::uuid
      `;
      if (existing.length > 0) return;
      const serves = await tx`
        INSERT INTO telemetry.feed_serves (
          feed_request_id,user_id,session_id,feed_version,generation_id,source,model_version,next_cursor
        ) VALUES (
          ${input.feed_request_id}::uuid,${input.user_id}::uuid,${input.session_id}::uuid,
          ${input.feed_version.toString()}::bigint,${input.generation_id}::uuid,${input.source},${input.model_version},${input.next_cursor}
        ) RETURNING serve_id
      `;
      const serveId = String(serves[0].serve_id);
      for (const item of input.items) {
        await tx`
          INSERT INTO telemetry.feed_serve_items (serve_id,position,repo_id,score,source,model_version,summary_id)
          VALUES (${serveId}::uuid,${item.position},${item.repo_id}::uuid,${item.score},${item.source},${item.model_version},${item.summary_id}::uuid)
        `;
      }
    });
    const stored = await this.getServeByRequest(input.user_id, input.feed_request_id);
    if (!stored) throw new Error('Serve was not persisted.');
    return stored;
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
             owner_profile.user_id AS owner_user_id,
             (viewer_follow.following_id IS NOT NULL) AS viewer_follows_owner
      FROM app.repos repo
      LEFT JOIN LATERAL (
        SELECT owner_user.user_id
        FROM app.users owner_user
        WHERE owner_user.status='active'
          AND owner_user.github_identity_verified_at IS NOT NULL
          AND owner_user.github_id IS NOT NULL
          AND owner_user.github_handle IS NOT NULL
          AND lower(owner_user.github_handle)=lower(repo.owner)
        ORDER BY owner_user.github_identity_verified_at DESC,owner_user.user_id ASC
        LIMIT 1
      ) owner_profile ON true
      LEFT JOIN app.follows viewer_follow
        ON viewer_follow.follower_id=${viewerUserId ?? null}::uuid
       AND viewer_follow.following_id=owner_profile.user_id
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

  async getTrendingFallback(limit: number, excludeRepoIds: string[]): Promise<RepositoryProjection[]> {
    const rows = await sqlClient`
      SELECT item.repo_id FROM app.trending_snapshot_items item
      JOIN app.trending_snapshots snapshot ON snapshot.snapshot_id=item.snapshot_id
      JOIN app.repos repo ON repo.repo_id=item.repo_id
      WHERE snapshot.complete AND snapshot.active AND repo.status='active'
        AND NOT (item.repo_id = ANY(${excludeRepoIds}::uuid[]))
      ORDER BY snapshot.activated_at DESC, item.position ASC LIMIT ${limit}
    `;
    const ids = rows.map((row) => String(row.repo_id));
    const projections = await this.listActiveRepositories(ids);
    const byId = new Map(projections.map((repo) => [repo.repo_id, repo]));
    return ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  }

  async hasServe(userId: string, feedRequestId: string): Promise<boolean> {
    return (await this.getServeByRequest(userId, feedRequestId)) !== null;
  }
}
