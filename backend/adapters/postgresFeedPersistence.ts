import { projectSocialCandidates, type SocialCandidateProjection } from '../services/socialCandidateProjection.js';
import { readmeSummaryProjection } from '../services/readmeSummaryService.js';
import type {
  CreateServeInput,
  RepositoryProjection,
  StoredServe,
  StoredServeItem,
} from '../contracts/feed.v2.js';
import { MAX_FEED_SERVE_LOOKUP_BATCH } from '../ports/feedPersistencePort.js';
import type {
  FeedPersistencePort, FeedReconciliationPersistencePort, FeedServeRequest, RepositoryIdentityProjection,
} from '../ports/feedPersistencePort.js';
import { isValidUuid } from '../utils/validators.js';
import { sqlClient } from '../db/index.js';
import { buildMlOnboardingJob, hasMlEmbeddingContext } from '../services/mlOnboardingService.js';

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
    summary_highlights: Array.isArray(row.summary_highlights) ? row.summary_highlights.map(String) : [],
    summary_prompt_version: row.summary_prompt_version == null ? null : String(row.summary_prompt_version),
    summary_model_version: row.summary_model_version == null ? null : String(row.summary_model_version),
    summary_format_version: row.summary_format_version == null ? null : String(row.summary_format_version),
    summary_source: row.summary_source === 'generated' || row.summary_source === 'description_fallback'
      ? row.summary_source : null,
    readme_digest: (row.readme_digest ?? null) as RepositoryProjection['readme_digest'],
    readme_md: row.readme == null ? null : String(row.readme),
    readme_source_path: row.readme_source_path == null ? null : String(row.readme_source_path),
    readme_default_branch: row.readme_default_branch == null ? null : String(row.readme_default_branch),
    readme_base_url: row.readme_base_url == null ? null : String(row.readme_base_url),
    updated_at: row.updated_at == null ? null : String(row.updated_at),
    viewer_reaction: row.viewer_reaction === 'like' || row.viewer_reaction === 'dislike'
      ? row.viewer_reaction : null,
    viewer_saved: Boolean(row.viewer_saved),
    viewer_follows_owner: Boolean(row.viewer_follows_owner),
    status: row.status as RepositoryProjection['status'],
  };
}

export class PostgresFeedPersistence implements FeedPersistencePort, FeedReconciliationPersistencePort {
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

  async getGenerationContext(userId: string) {
    await this.getFeedVersion(userId);
    const rows = await sqlClient`
      SELECT state.feed_version,u.profile_version,
        COALESCE(job.profile_version=u.profile_version,false) AS delivered
      FROM app.users u JOIN app.user_feed_state state USING(user_id)
      LEFT JOIN telemetry.feed_prewarm_jobs job USING(user_id)
      WHERE u.user_id=${userId}::uuid AND u.status='active'
    `;
    return rows[0] ? { feedVersion: BigInt(rows[0].feed_version),
      profileVersion: BigInt(rows[0].profile_version), delivered: rows[0].delivered === true } : null;
  }

  async recordMlProfileDelivered(userId: string, profileVersion: bigint): Promise<boolean> {
    return sqlClient.begin(async tx => {
      // The network call has already finished. Lock the user before feed/job
      // access and reject an acknowledgement for a superseded profile.
      const users = await tx`SELECT user_id FROM app.users
        WHERE user_id=${userId}::uuid AND status='active'
          AND profile_version=${profileVersion.toString()}::bigint FOR KEY SHARE`;
      if (!users.length) return false;
      await tx`INSERT INTO app.user_feed_state(user_id) VALUES(${userId}::uuid)
        ON CONFLICT(user_id) DO NOTHING`;
      await tx`
        INSERT INTO telemetry.feed_prewarm_jobs(user_id,feed_version,profile_version)
        SELECT user_id,feed_version,${profileVersion.toString()}::bigint
        FROM app.user_feed_state WHERE user_id=${userId}::uuid
        ON CONFLICT(user_id) DO UPDATE SET feed_version=EXCLUDED.feed_version,
          profile_version=EXCLUDED.profile_version,status='pending',scheduled_at=now(),
          available_at=now(),claimed_at=NULL,claim_token=NULL,attempts=0,last_error=NULL
        WHERE telemetry.feed_prewarm_jobs.profile_version<>EXCLUDED.profile_version
          OR telemetry.feed_prewarm_jobs.feed_version<>EXCLUDED.feed_version
      `;
      return true;
    });
  }

  async hasServedFeed(userId: string, feedVersion: bigint): Promise<boolean> {
    const rows = await sqlClient`SELECT 1 FROM telemetry.feed_serves
      WHERE user_id=${userId}::uuid AND feed_version=${feedVersion.toString()}::bigint LIMIT 1`;
    return rows.length > 0;
  }

  async hasPublishedGeneration(userId: string, feedVersion: bigint): Promise<boolean> {
    const rows = await sqlClient`
      SELECT state.last_published_feed_version >= ${feedVersion.toString()}::bigint
        OR EXISTS (SELECT 1 FROM telemetry.generation_attempts attempt
          WHERE attempt.user_id=state.user_id AND attempt.feed_version=${feedVersion.toString()}::bigint
            AND attempt.status='completed' AND attempt.mode IN ('live','prewarm'))
        AS published
      FROM app.user_feed_state state WHERE state.user_id=${userId}::uuid
    `;
    return rows[0]?.published === true;
  }

  async markGenerationPublished(userId: string, feedVersion: bigint): Promise<void> {
    await sqlClient`
      UPDATE app.user_feed_state SET last_published_feed_version=
        greatest(last_published_feed_version,${feedVersion.toString()}::bigint)
      WHERE user_id=${userId}::uuid AND feed_version>=${feedVersion.toString()}::bigint
    `;
  }

  async getFeedVersion(userId: string): Promise<bigint> {
    const rows = await sqlClient`SELECT feed_version FROM app.user_feed_state WHERE user_id=${userId}::uuid`;
    if (rows.length) return BigInt(rows[0].feed_version);
    return sqlClient.begin(async tx => {
      // Missing-state initialization must use the same user-before-feed order
      // as profile and interaction writers, including the INSERT's FK check.
      await tx`SELECT user_id FROM app.users WHERE user_id=${userId}::uuid FOR KEY SHARE`;
      const inserted = await tx`
        INSERT INTO app.user_feed_state (user_id) VALUES (${userId}::uuid)
        ON CONFLICT (user_id) DO NOTHING RETURNING feed_version
      `;
      if (inserted.length) return BigInt(inserted[0].feed_version);
      const current = await tx`SELECT feed_version FROM app.user_feed_state WHERE user_id=${userId}::uuid`;
      if (!current.length) throw new Error('User feed state is unavailable.');
      return BigInt(current[0].feed_version);
    });
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

  async getMlOnboardingJob(userId: string) {
    const rows = await sqlClient`
      SELECT username,full_name,bio,github_handle,avatar_url,interests,skills,tech_stack,
             profile_version,onboarding_completed
      FROM app.users
      WHERE user_id=${userId}::uuid AND status='active'
      LIMIT 1
    `;
    const row = rows[0];
    if (!row || row.onboarding_completed !== true) return null;
    const job = buildMlOnboardingJob(userId, Number(row.profile_version), {
      username: row.username == null ? null : String(row.username),
      fullName: row.full_name == null ? null : String(row.full_name),
      bio: row.bio == null ? null : String(row.bio),
      githubUsername: row.github_handle == null ? null : String(row.github_handle),
      avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
      interests: Array.isArray(row.interests) ? row.interests.map(String) : [],
      skills: Array.isArray(row.skills) ? row.skills.map(String) : [],
      techStack: Array.isArray(row.tech_stack) ? row.tech_stack.map(String) : [],
    });
    return hasMlEmbeddingContext(job.profile) ? job : null;
  }

  async getRecentPersonalizedEntries(
    userId: string,
    feedVersion: bigint,
    limit: number,
    excludeRepoIds: string[],
  ) {
    const rows = await sqlClient`
      WITH candidates AS (
        SELECT item.repo_id,item.score,item.source,item.model_version,current_summary.summary_id,serve.generation_id,
               serve.created_at,item.position,
               row_number() OVER (
                 PARTITION BY item.repo_id ORDER BY serve.created_at DESC,item.position ASC
               ) AS repo_rank
        FROM telemetry.feed_serves serve
        JOIN telemetry.feed_serve_items item USING(serve_id)
        JOIN app.repos repo ON repo.repo_id=item.repo_id AND repo.status='active'
        JOIN app.repo_content content ON content.repo_id=repo.repo_id
        LEFT JOIN LATERAL (
          SELECT card.summary_id FROM app.repo_card_summaries card
          WHERE card.repo_id=repo.repo_id AND card.active
            AND card.content_version=content.content_version
            AND to_jsonb(card)->>'source' IN ('generated','description_fallback')
          ORDER BY card.created_at DESC LIMIT 1
        ) current_summary ON true
        WHERE serve.user_id=${userId}::uuid
          AND serve.feed_version=${feedVersion.toString()}::bigint
          AND serve.source='personalized'
          AND NOT (item.repo_id=ANY(${excludeRepoIds}::uuid[]))
      )
      SELECT repo_id,score,source,model_version,summary_id,generation_id
      FROM candidates WHERE repo_rank=1
      ORDER BY created_at DESC,position ASC
      LIMIT ${Math.max(1, Math.min(100, limit))}
    `;
    return rows.map((row) => ({
      repo_id: String(row.repo_id),
      score: Number(row.score ?? 0),
      source: String(row.source),
      model_version: String(row.model_version),
      summary_id: row.summary_id == null ? null : String(row.summary_id),
      ...(row.generation_id == null ? {} : { generation_id: String(row.generation_id) }),
    }));
  }

  /** Independent, viewer-scoped public-catalogue candidates; never infer ownership from a handle. */
  async listSocialRepositoryCandidates(userId: string, limit: number): Promise<SocialCandidateProjection[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid social candidate limit.');
    const rows = await sqlClient`
      WITH viewer AS (SELECT user_id FROM app.users WHERE user_id=${userId}::uuid AND status='active'), subjects AS (
        SELECT followed.github_id AS owner_id,'registered:' || followed.user_id::text AS actor_key,follow.created_at
        FROM app.follows follow
        JOIN app.users followed ON followed.user_id=follow.following_id
        WHERE follow.follower_id IN (SELECT user_id FROM viewer) AND followed.status='active'
          AND followed.github_identity_verified_at IS NOT NULL
        UNION ALL
        SELECT profile.provider_subject,'external:' || profile.profile_id::text,follow.created_at
        FROM app.social_profile_follows follow
        JOIN app.social_profiles profile ON profile.profile_id=follow.profile_id
        WHERE follow.follower_id IN (SELECT user_id FROM viewer) AND profile.provider='github'
          AND profile.status='active' AND profile.claimed_by_user_id IS NULL
      ), owners AS MATERIALIZED (
        SELECT owner_id,max(created_at) AS followed_at,array_agg(DISTINCT actor_key ORDER BY actor_key) AS actors
        FROM subjects
        WHERE owner_id ~ '^[1-9][0-9]{0,18}$'
          AND CASE WHEN owner_id ~ '^[1-9][0-9]{0,18}$' THEN owner_id::numeric <= 9223372036854775807 ELSE false END
        GROUP BY owner_id ORDER BY max(created_at) DESC,owner_id LIMIT 50
      )
      SELECT candidate.repo_id,candidate.owner_github_id::text AS owner_github_id,candidate.star_count,actor.actor_key
      FROM owners
      CROSS JOIN LATERAL (
        SELECT repo.repo_id,repo.owner_github_id,stats.star_count
        FROM app.repos repo
        CROSS JOIN LATERAL (
          SELECT snapshot.star_count FROM app.repo_stat_snapshots snapshot
          WHERE snapshot.repo_id=repo.repo_id ORDER BY snapshot.observed_at DESC LIMIT 1
        ) stats
        WHERE repo.owner_github_id=owners.owner_id::bigint AND repo.status='active'
        ORDER BY repo.updated_at DESC,repo.repo_id LIMIT 2
      ) candidate
      CROSS JOIN LATERAL unnest(owners.actors) AS actor(actor_key)
      ORDER BY owners.followed_at DESC,owners.owner_id,candidate.repo_id,actor.actor_key
      LIMIT 10001
    `;
    return projectSocialCandidates(rows.map(row => ({
      repo_id: String(row.repo_id), owner_github_id: String(row.owner_github_id),
      source: 'followed_owner', actor_key: String(row.actor_key), star_count: Number(row.star_count),
      // Public catalogue, current active verified/unclaimed follow subjects only.
      repo_status: 'active', viewer_can_access: true, actor_active: true, signal_allowed: true,
    })), { maxCandidates: limit });
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
      SELECT item.serve_id,item.position,item.repo_id,item.score,item.source,item.model_version,
             COALESCE(exact_summary.summary_id,current_summary.summary_id) AS summary_id,
             ${sqlClient.unsafe(readmeSummaryProjection('repo','content'))},
             repo.full_name, repo.updated_at, content.description, content.primary_language,
             content.languages, content.readme,to_jsonb(content)->>'readme_source_path' AS readme_source_path,
             to_jsonb(content)->>'readme_default_branch' AS readme_default_branch,to_jsonb(content)->>'readme_base_url' AS readme_base_url,
             COALESCE(topic_values.topics, '[]'::jsonb) AS topics,
             stats.star_count, stats.fork_count, stats.open_issues_count,
             engagement.likes_count, engagement.comments_count, engagement.views_count,
             COALESCE(exact_summary.summary,current_summary.summary) AS summary,
             COALESCE((to_jsonb(exact_summary)->'highlights'),current_summary.highlights,'[]'::jsonb) AS summary_highlights,
             COALESCE((to_jsonb(exact_summary)->>'prompt_version'),current_summary.prompt_version) AS summary_prompt_version,
             COALESCE(exact_summary.model_version,current_summary.model_version) AS summary_model_version,
             COALESCE((to_jsonb(exact_summary)->>'format_version'),current_summary.format_version) AS summary_format_version,
             COALESCE((to_jsonb(exact_summary)->>'source'),current_summary.source) AS summary_source,
             reaction.reaction AS viewer_reaction,
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
      LEFT JOIN app.repo_card_summaries exact_summary
        ON exact_summary.summary_id=item.summary_id
       AND exact_summary.repo_id=repo.repo_id
       AND exact_summary.content_version=content.content_version
       AND (to_jsonb(exact_summary)->>'source') IN ('generated','description_fallback')
       AND char_length(btrim(exact_summary.summary)) BETWEEN 1 AND 360
      LEFT JOIN LATERAL (
        SELECT card.summary_id,card.summary,to_jsonb(card)->'highlights' AS highlights,
          to_jsonb(card)->>'prompt_version' AS prompt_version,card.model_version,
          to_jsonb(card)->>'format_version' AS format_version,to_jsonb(card)->>'source' AS source
        FROM app.repo_card_summaries card
        WHERE card.repo_id=repo.repo_id AND card.active
          AND card.content_version=content.content_version
          AND to_jsonb(card)->>'source' IN ('generated','description_fallback')
        ORDER BY card.created_at DESC LIMIT 1
      ) current_summary ON exact_summary.summary_id IS NULL
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

  async listActiveRepositoryIdentities(repoIds: string[]): Promise<RepositoryIdentityProjection[]> {
    if (repoIds.length === 0) return [];
    const rows = await sqlClient`
      SELECT repo.repo_id, summary.summary_id
      FROM app.repos repo
      LEFT JOIN app.repo_content content ON content.repo_id=repo.repo_id
      LEFT JOIN app.repo_card_summaries summary ON summary.repo_id=repo.repo_id AND summary.active
        AND summary.content_version=content.content_version
        AND to_jsonb(summary.*)->>'source' IN ('generated','description_fallback')
      WHERE repo.repo_id = ANY(${repoIds}::uuid[]) AND repo.status='active'
    `;
    return rows.map((row) => ({
      repo_id: String(row.repo_id),
      summary_id: row.summary_id == null ? null : String(row.summary_id),
    }));
  }

  async listActiveRepositories(repoIds: string[], viewerUserId?: string): Promise<RepositoryProjection[]> {
    if (repoIds.length === 0) return [];
    const rows = await sqlClient`
      SELECT ${sqlClient.unsafe(readmeSummaryProjection('repo','content'))},
             repo.repo_id, repo.full_name, repo.status, repo.updated_at, content.description,
             content.primary_language,content.languages,content.readme,to_jsonb(content)->>'readme_source_path' AS readme_source_path,
             to_jsonb(content)->>'readme_default_branch' AS readme_default_branch,to_jsonb(content)->>'readme_base_url' AS readme_base_url,
             COALESCE(topic_values.topics, '[]'::jsonb) AS topics,
             COALESCE(stats.star_count, 0) AS star_count, COALESCE(stats.fork_count, 0) AS fork_count, COALESCE(stats.open_issues_count, 0) AS open_issues_count,
             COALESCE(engagement.likes_count, 0) AS likes_count, COALESCE(engagement.comments_count, 0) AS comments_count, COALESCE(engagement.views_count, 0) AS views_count,
             summary.summary_id,summary.summary,to_jsonb(summary.*)->'highlights' AS summary_highlights,
             to_jsonb(summary.*)->>'prompt_version' AS summary_prompt_version,
             summary.model_version AS summary_model_version,
             to_jsonb(summary.*)->>'format_version' AS summary_format_version,to_jsonb(summary.*)->>'source' AS summary_source,
             reaction.reaction AS viewer_reaction,
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
        AND summary.content_version=content.content_version
        AND to_jsonb(summary.*)->>'source' IN ('generated','description_fallback')
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
    if (!isValidUuid(userId) || !isValidUuid(feedRequestId)) return false;
    const rows = await sqlClient`
      SELECT EXISTS (
        SELECT 1 FROM telemetry.feed_serves
        WHERE user_id=${userId}::uuid AND feed_request_id=${feedRequestId}::uuid
      ) AS present
    `;
    return rows[0].present === true;
  }

  async listServedRequests(requests: FeedServeRequest[]): Promise<FeedServeRequest[]> {
    const unique = new Map<string, { user_id: string; feed_request_id: string }>();
    for (const request of requests) {
      if (!isValidUuid(request.userId) || !isValidUuid(request.requestId)) continue;
      const user_id = request.userId.toLowerCase(), feed_request_id = request.requestId.toLowerCase();
      unique.set(`${user_id}:${feed_request_id}`, { user_id, feed_request_id });
    }
    if (unique.size === 0) return [];
    if (unique.size > MAX_FEED_SERVE_LOOKUP_BATCH) throw new Error('Feed serve lookup batch exceeds its limit.');
    const rows = await sqlClient`
      SELECT serve.user_id,serve.feed_request_id
      FROM telemetry.feed_serves serve
      JOIN jsonb_to_recordset(${JSON.stringify([...unique.values()])}::jsonb)
        AS requested(user_id uuid,feed_request_id uuid)
        ON serve.user_id=requested.user_id AND serve.feed_request_id=requested.feed_request_id
    `;
    return rows.map(row => ({ userId: String(row.user_id), requestId: String(row.feed_request_id) }));
  }
}
