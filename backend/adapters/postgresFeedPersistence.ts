import { projectRepositoryLanguages } from '../services/repositoryLanguages.js';
import { unfamiliarRepositorySql, canonicalGithubIdSql } from '../services/familiarRepositoryEligibility.js';
import { lockModelLane } from '../services/modelOperationService.js';
import { lockedSession } from '../services/feedIntentSessionService.js';
import { ModelOperationError } from '../contracts/modelOperations.js';
import { FeedProvenanceUnavailableError, FeedProvenanceDependencyError } from '../ports/feedPersistencePort.js';
import { loadSocialNeighborhoodRows } from '../services/socialNeighborhoodProjection.js';
import { projectSocialCandidates, type SocialCandidateProjection } from '../services/socialCandidateProjection.js';
import { readmeSummaryProjection } from '../services/readmeSummaryService.js';
import type {
  CreateServeInput,
  RepositoryProjection,
  StoredServe,
  StoredServeItem,
} from '../contracts/feed.v2.js';
import { loadNegativePreferenceEligibleIds } from '../services/negativePreferenceEligibility.js';
import { loadCandidateEligibility, loadRecentExposureEligibleIds } from '../services/feedExposureEligibility.js';
import { feedRecentExposureDays } from '../config/feedExposure.js';
import { FeedExposureChangedError, FeedServeOverlapError, FeedPreferenceChangedError, MAX_FEED_SERVE_LOOKUP_BATCH } from '../ports/feedPersistencePort.js';
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
    ...projectRepositoryLanguages(row),
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

/** Embed trusted parameterized SQL using the driver's tagged bindings.
 * unsafe($1, values) must remain a root query: it does not renumber nested placeholders.
 */
function boundSql(text: string, parameters: readonly (string|string[])[]) {
  const strings: string[] = []; const values: (string|string[])[] = [];
  let offset = 0;
  for (const match of text.matchAll(/\$(\d+)/g)) {
    strings.push(text.slice(offset,match.index));
    const value = parameters[Number(match[1])-1];
    if (value === undefined) throw new Error('Missing internal SQL binding.');
    values.push(value); offset = match.index! + match[0].length;
  }
  strings.push(text.slice(offset));
  return sqlClient(Object.assign(strings,{raw:[...strings]}) as TemplateStringsArray,...values);
}

export class PostgresFeedPersistence implements FeedPersistencePort, FeedReconciliationPersistencePort {
  private readonly recentExposureDays = feedRecentExposureDays();

  async listCandidateEligibility(userId: string, repoIds: string[], sessionId?: string) {
    const repositories: RepositoryProjection[] = [];
    const result = await loadCandidateEligibility({ query: async (text, parameters) => {
      if (!sessionId) return [...await sqlClient.unsafe(text, [...parameters])];
      const rows = await this.activeRepositoryRows(repoIds,userId,{text,parameters});
      repositories.push(...rows.map(row=>projection(row)));
      return [...rows];
    } }, userId, repoIds, this.recentExposureDays, sessionId);
    return {...result, ...(sessionId ? {repositories} : {})};
  }

  async listExposureEligibleRepositoryIds(userId: string, repoIds: string[]): Promise<string[]> {
    return loadRecentExposureEligibleIds({
      query: async (text, parameters) => [...await sqlClient.unsafe(text, [...parameters])],
    }, userId, repoIds, this.recentExposureDays);
  }

  async listPreferenceEligibleRepositoryIds(userId: string, repoIds: string[]): Promise<string[]> {
    return loadNegativePreferenceEligibleIds({
      query: async (text, parameters) => [...await sqlClient.unsafe(text, [...parameters])],
    }, userId, repoIds);
  }

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

  async getGenerationContext(userId: string): Promise<import('../ports/feedPersistencePort.js').FeedGenerationContext | null> {
    const rows = await sqlClient`
      SELECT state.feed_version,u.profile_version,state.model_policy_sha256,
        COALESCE(job.profile_version=u.profile_version,false) AS delivered
      FROM app.users u JOIN app.user_feed_state state USING(user_id)
      LEFT JOIN telemetry.feed_prewarm_jobs job USING(user_id)
      WHERE u.user_id=${userId}::uuid AND u.status='active'
    `;
    if (!rows.length) {
      const [user] = await sqlClient`SELECT 1 FROM app.users WHERE user_id=${userId}::uuid AND status='active'`;
      if (!user) return null;
      await this.getFeedVersion(userId);
      return this.getGenerationContext(userId);
    }
    return rows[0] ? { feedVersion: BigInt(rows[0].feed_version),
      profileVersion: BigInt(rows[0].profile_version), delivered: rows[0].delivered === true,
      ...(rows[0].model_policy_sha256?{modelPolicySha256:String(rows[0].model_policy_sha256)}:{}) } : null;
  }

  async recordMlProfileDelivered(userId: string, profileVersion: bigint): Promise<boolean> {
    return sqlClient.begin(async tx => {
      // The network call has already finished. Lock the user before feed/job
      // access and reject an acknowledgement for a superseded profile.
      const users = await tx`SELECT user_id FROM app.users
        WHERE user_id=${userId}::uuid AND status='active'
          AND profile_version=${profileVersion.toString()}::bigint
          AND NOT EXISTS(SELECT 1 FROM app.user_feed_state WHERE user_id=app.users.user_id AND model_policy_sha256 IS NOT NULL) FOR KEY SHARE`;
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
        -- Preserve the original serve/interaction history budget first. Exact
        -- familiarity eligibility remains authoritative beyond these ML hints.
        SELECT repo.repo_id,NULL::timestamptz AS observed_at,2 AS priority
        FROM app.users feed_viewer JOIN app.repos repo
          ON repo.owner_github_id=${sqlClient.unsafe(canonicalGithubIdSql('feed_viewer.github_id'))}
        WHERE feed_viewer.user_id=${userId}::uuid AND feed_viewer.github_identity_verified_at IS NOT NULL
          AND repo.status='active'
        UNION ALL
        SELECT repo.repo_id,NULL::timestamptz AS observed_at,2 AS priority
        FROM app.users feed_viewer JOIN app.user_github_imports imported
          ON imported.user_id=feed_viewer.user_id AND imported.github_id=feed_viewer.github_id
          AND imported.accepted_at IS NOT NULL AND imported.revoked_at IS NULL
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(imported.provenance->'repository_ids')='array'
          THEN imported.provenance->'repository_ids' ELSE '[]'::jsonb END) known(value)
        JOIN app.repos repo ON repo.github_id=${sqlClient.unsafe(canonicalGithubIdSql("known.value->>'github_id'"))}
        WHERE feed_viewer.user_id=${userId}::uuid AND feed_viewer.github_identity_verified_at IS NOT NULL
          AND repo.status='active'
        UNION ALL
        SELECT item.repo_id,serve.created_at AS observed_at,0 AS priority
        FROM telemetry.feed_serves serve
        JOIN telemetry.feed_serve_items item ON item.serve_id=serve.serve_id
        WHERE serve.user_id=${userId}::uuid
          AND (serve.session_id=${sessionId ?? null}::uuid
            OR serve.created_at>=now()-(${this.recentExposureDays * 86400}::integer * interval '1 second'))
        UNION ALL
        SELECT repo_id,server_received_at AS observed_at,1 AS priority
        FROM telemetry.interaction_events WHERE user_id=${userId}::uuid
          AND server_received_at>=now()-(${this.recentExposureDays * 86400}::integer * interval '1 second')
      )
      SELECT repo_id FROM exposures GROUP BY repo_id
      ORDER BY min(priority),max(observed_at) DESC,repo_id LIMIT ${boundedLimit}
    `;
    return rows.map(row => String(row.repo_id));
  }

  async listServedRepositoryIds(userId: string, sessionId: string, repoIds: string[]): Promise<string[]> {
    if (repoIds.length > 100) throw new Error('Session delivery lookup exceeds the bounded candidate batch.');
    if (repoIds.length === 0) return [];
    const rows = await sqlClient`
      SELECT DISTINCT item.repo_id FROM telemetry.feed_serves serve
      JOIN telemetry.feed_serve_items item ON item.serve_id=serve.serve_id
      WHERE serve.user_id=${userId}::uuid AND serve.session_id=${sessionId}::uuid
        AND item.repo_id=ANY(${repoIds}::uuid[])
    `;
    return rows.map(row => String(row.repo_id));
  }

  async getMlOnboardingJob(userId: string) {
    const rows = await sqlClient`
      SELECT username,full_name,bio,github_handle,avatar_url,interests,skills,tech_stack,
             profile_version,onboarding_completed
      FROM app.users
      WHERE user_id=${userId}::uuid AND status='active'
        AND NOT EXISTS(SELECT 1 FROM app.user_feed_state WHERE user_id=app.users.user_id AND model_policy_sha256 IS NOT NULL)
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
    sessionId?: string,
  ) {
    const rows = await sqlClient`
      WITH candidates AS (
        SELECT item.repo_id,item.score,item.source,item.model_version,current_summary.summary_id,provenance.generation_id,
               provenance.record_digest,provenance.capture_status,
               COALESCE(provenance.legacy_generation_hint,CASE WHEN provenance.serve_id IS NULL THEN serve.generation_id END) AS legacy_generation_hint,
               serve.created_at,item.position,
               row_number() OVER (
                 PARTITION BY item.repo_id ORDER BY serve.created_at DESC,item.position ASC
               ) AS repo_rank
        FROM telemetry.feed_serves serve
        JOIN telemetry.feed_serve_items item USING(serve_id)
        LEFT JOIN telemetry.feed_item_provenance provenance ON provenance.serve_id=item.serve_id AND provenance.position=item.position
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
          AND ${sqlClient.unsafe(unfamiliarRepositorySql('serve.user_id'))}
          AND NOT (item.repo_id=ANY(${excludeRepoIds}::uuid[]))
          AND NOT EXISTS (
            SELECT 1 FROM telemetry.feed_serves delivered
            JOIN telemetry.feed_serve_items seen ON seen.serve_id=delivered.serve_id
            WHERE delivered.user_id=${userId}::uuid AND delivered.session_id=${sessionId ?? null}::uuid
              AND seen.repo_id=item.repo_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM app.reactions negative
            WHERE negative.user_id=serve.user_id AND negative.repo_id=item.repo_id
              AND negative.reaction='dislike'
          )
          AND NOT EXISTS (
            SELECT 1 FROM telemetry.feed_serves recent_serve
            JOIN telemetry.feed_serve_items seen_item ON seen_item.serve_id=recent_serve.serve_id
            WHERE recent_serve.user_id=${userId}::uuid AND seen_item.repo_id=item.repo_id
              AND recent_serve.created_at>=now()-(${this.recentExposureDays * 86400}::integer * interval '1 second')
          )
          AND NOT EXISTS (
            SELECT 1 FROM telemetry.interaction_events recent_event
            WHERE recent_event.user_id=${userId}::uuid AND recent_event.repo_id=item.repo_id
              AND recent_event.server_received_at>=now()-(${this.recentExposureDays * 86400}::integer * interval '1 second')
          )
      )
      SELECT repo_id,score,source,model_version,summary_id,generation_id,record_digest,capture_status,legacy_generation_hint
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
      ...(row.legacy_generation_hint == null ? {} : {legacy_generation_hint:String(row.legacy_generation_hint)}),
      ...(row.capture_status !== 'captured' ? {} : { scoring_reference: {generation_id:String(row.generation_id),
        repo_id:String(row.repo_id),record_digest:String(row.record_digest)} }),
    }));
  }

  /** Independent, viewer-scoped public-catalogue candidates; never infer ownership from a handle. */
  async listSocialRepositoryCandidates(userId: string, limit: number, excludeRepoIds: string[] = []): Promise<SocialCandidateProjection[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid social candidate limit.');
    return sqlClient.begin('isolation level repeatable read read only', async tx => {
      await tx`SET LOCAL statement_timeout='1000ms'`;
      const rows = await tx`
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
            AND NOT (repo.repo_id=ANY(${excludeRepoIds}::uuid[]))
          ORDER BY repo.updated_at DESC,repo.repo_id LIMIT 2
        ) candidate
        CROSS JOIN LATERAL unnest(owners.actors) AS actor(actor_key)
        ORDER BY owners.followed_at DESC,owners.owner_id,candidate.repo_id,actor.actor_key
        LIMIT 10001
      `;
      const neighborhoods = await loadSocialNeighborhoodRows({
        query: async (text, parameters) => [...await tx.unsafe(text, [...parameters])],
      }, userId, excludeRepoIds);
      const ownerRows = rows.map(row => ({
        repo_id: String(row.repo_id), owner_github_id: String(row.owner_github_id),
        source: 'followed_owner' as const, actor_key: String(row.actor_key), star_count: Number(row.star_count),
        // Public catalogue, current active verified/unclaimed follow subjects only.
        repo_status: 'active', viewer_can_access: true, actor_active: true, signal_allowed: true,
      }));
      return projectSocialCandidates([...ownerRows, ...neighborhoods], { maxCandidates: limit });
    });
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
             provenance.exposure_id,provenance.generation_id,provenance.record_digest,provenance.capture_status,
             COALESCE(provenance.legacy_generation_hint,CASE WHEN provenance.serve_id IS NULL THEN ${serve.generation_id ?? null}::uuid END) AS legacy_generation_hint,
             COALESCE(exact_summary.summary_id,current_summary.summary_id) AS summary_id,
             ${sqlClient.unsafe(readmeSummaryProjection('repo','content'))},
             repo.full_name, repo.updated_at, content.description, content.primary_language,
             content.languages,content.language_breakdown,content.language_total_size::float8 AS language_total_size,content.language_breakdown_complete,content.language_observed_at, content.readme,content.readme_source_path AS readme_source_path,
             content.readme_default_branch AS readme_default_branch,content.readme_base_url AS readme_base_url,
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
      LEFT JOIN telemetry.feed_item_provenance provenance ON provenance.serve_id=item.serve_id AND provenance.position=item.position
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
      ...(row.exposure_id == null ? {} : {exposure_id:String(row.exposure_id)}),
      ...(row.generation_id == null ? {} : {generation_id:String(row.generation_id)}),
      ...(row.legacy_generation_hint == null ? {} : {legacy_generation_hint:String(row.legacy_generation_hint)}),
      ...(row.capture_status !== 'captured' ? {} : {scoring_reference:{generation_id:String(row.generation_id),
        repo_id:String(row.repo_id),record_digest:String(row.record_digest)}}),
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
    for (const item of input.items) if (item.legacy_generation_hint!==undefined
      && (item.scoring_reference || typeof item.legacy_generation_hint!=='string' || item.legacy_generation_hint.length!==36
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.legacy_generation_hint))) {
      throw new FeedProvenanceUnavailableError();
    }
    for (const item of input.items) if (item.scoring_reference) {
      const reference=item.scoring_reference;
      if (typeof reference!=='object' || Array.isArray(reference)
        || Object.keys(reference).sort().join(',')!=='generation_id,record_digest,repo_id'
        || reference.repo_id!==item.repo_id || reference.generation_id!==item.generation_id
        || typeof reference.generation_id!=='string' || reference.generation_id.length!==36
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reference.generation_id)
        || typeof reference.record_digest!=='string' || reference.record_digest.length!==64
        || !/^[0-9a-f]{64}$/.test(reference.record_digest)) throw new FeedProvenanceUnavailableError();
    }
    const created = await sqlClient.begin(async (tx) => {
      // Match activity/profile lock order: user, then feed state. Current
      // reactions and new serves serialize; session duplicate fencing is separate.
      await tx`SELECT user_id FROM app.users WHERE user_id=${input.user_id}::uuid FOR KEY SHARE`;
      let [state] = await tx`SELECT user_id,model_policy_sha256,model_policy_limits,model_initialized,feedback_version,feed_version
        FROM app.user_feed_state WHERE user_id=${input.user_id}::uuid FOR UPDATE`;
      if (!state) {
        await tx`INSERT INTO app.user_feed_state(user_id) VALUES(${input.user_id}::uuid) ON CONFLICT DO NOTHING`;
        [state] = await tx`SELECT user_id,model_policy_sha256,model_policy_limits,model_initialized,feedback_version,feed_version
          FROM app.user_feed_state WHERE user_id=${input.user_id}::uuid FOR UPDATE`;
      }
      if (state && BigInt(state.feed_version) !== input.feed_version) {
        // A concurrent successful replay remains authoritative even after a version change.
        const [existing] = await tx`SELECT serve_id FROM telemetry.feed_serves
          WHERE user_id=${input.user_id}::uuid AND feed_request_id=${input.feed_request_id}::uuid`;
        if (!existing) throw new FeedPreferenceChangedError();
      }
      const lane=await lockModelLane(tx,input.user_id,state);
      if(lane){
        const scope=input.intent_scope;
        if(!scope||!lane.initialized||scope.userId!==input.user_id||scope.sessionId!==input.session_id||scope.policySha256!==lane.policySha256)throw new ModelOperationError('MODEL_SESSION_PENDING',409);
        const session=await lockedSession(tx,lane,input.session_id);
        const [frontier]=await tx`SELECT state.feed_version,state.model_operation_version,u.profile_version FROM app.user_feed_state state JOIN app.users u USING(user_id) WHERE state.user_id=${input.user_id}::uuid`;
        if(session.status!=='active'||session.epoch!==scope.epoch||session.witnessSha256!==scope.witnessSha256
          ||String(frontier.feed_version)!==scope.feedVersion||String(frontier.profile_version)!==scope.profileVersion
          ||String(frontier.model_operation_version)!==scope.acceptedOperationVersion||scope.applied.applied_operation_version!==scope.acceptedOperationVersion)throw new ModelOperationError('MODEL_SESSION_PENDING',409);
        const ids=[...new Set(input.items.map(item=>item.generation_id).filter((id):id is string=>Boolean(id)))];
        if(input.items.some(item=>!item.generation_id))throw new ModelOperationError();
        const generations=await tx`SELECT generation_id FROM telemetry.feed_model_generations WHERE generation_id=ANY(${ids}::uuid[])
          AND user_id=${input.user_id}::uuid AND session_id=${input.session_id}::uuid AND queue_scope=${scope.queueScope}
          AND valid_until_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint FOR KEY SHARE`;
        if(generations.length!==ids.length||BigInt(scope.applied.valid_until_ms)<=BigInt(Date.now()))throw new ModelOperationError('MODEL_SESSION_PENDING',409);
      }else if(input.intent_scope)throw new ModelOperationError();
      // Serialize final delivery decisions within one viewer/session. A queued
      // page and durable recovery may both pass their earlier exclusion read;
      // only one may commit overlapping candidates. Retain the user-before-feed
      // lock order above before acquiring this session delivery fence.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(
        'feed-serve:' || ${input.user_id}::uuid::text || ':' || ${input.session_id}::uuid::text,0))`;
      const headers = await tx`
        INSERT INTO telemetry.feed_serves (
          feed_request_id,user_id,session_id,feed_version,generation_id,source,model_version,next_cursor,
          intent_epoch,intent_epoch_started_ms,intent_epoch_witness_sha256,intent_policy_sha256
        ) SELECT
          ${input.feed_request_id}::uuid,${input.user_id}::uuid,${input.session_id}::uuid,
          ${input.feed_version.toString()}::bigint,${input.generation_id}::uuid,${input.source},${input.model_version},${input.next_cursor},
          ${input.intent_scope?.epoch??null}::bigint,${input.intent_scope?.epochStartedMs??null}::bigint,
          ${input.intent_scope?.witnessSha256??null},${input.intent_scope?.policySha256??null}
        WHERE ${input.source !== 'personalized'} OR NOT EXISTS (
          SELECT 1 FROM telemetry.feed_serves delivered
          JOIN telemetry.feed_serve_items seen ON seen.serve_id=delivered.serve_id
          WHERE delivered.user_id=${input.user_id}::uuid AND delivered.session_id=${input.session_id}::uuid
            AND delivered.feed_request_id<>${input.feed_request_id}::uuid
            AND seen.repo_id=ANY(${input.items.map(item => item.repo_id)}::uuid[])
        )
        ON CONFLICT (feed_request_id) DO NOTHING RETURNING serve_id,created_at
      `;
      if (!headers.length) return null;
      const header = headers[0];
      const eligibility = await loadCandidateEligibility({
        query: async (text, parameters) => [...await tx.unsafe(text, [...parameters])],
      }, input.user_id, input.items.map(item => item.repo_id), this.recentExposureDays);
      const eligible = new Set(eligibility.preferenceIds);
      if (input.items.some(item => !eligible.has(item.repo_id))) throw new FeedPreferenceChangedError();
      const unexposed = new Set(eligibility.exposureIds);
      if (input.items.some(item => !unexposed.has(item.repo_id))) throw new FeedExposureChangedError();
      let provenance: Array<Record<string, unknown>> = [];
      if (input.items.length) {
        const items = input.items.map(item => ({position:item.position,repo_id:item.repo_id,score:item.score,
          source:item.source,model_version:item.model_version,summary_id:item.summary_id,
          generation_id:item.generation_id ?? null,legacy_generation_hint:item.legacy_generation_hint ?? null,
          record_digest:item.scoring_reference?.record_digest ?? null,
          capture_status:item.scoring_reference ? 'captured' : 'not_captured'}));
        provenance = [...await tx`
          WITH input AS MATERIALIZED (
            SELECT * FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS item(
              position smallint,repo_id uuid,score double precision,source text,model_version text,summary_id uuid,
              generation_id uuid,legacy_generation_hint uuid,record_digest text,capture_status text)
          ), inserted_items AS (
            INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version,summary_id)
            SELECT ${String(header.serve_id)}::uuid,position,repo_id,score,source,model_version,summary_id FROM input
            RETURNING position,repo_id
          )
          INSERT INTO telemetry.feed_item_provenance(serve_id,position,user_id,repo_id,generation_id,legacy_generation_hint,record_digest,capture_status)
          SELECT ${String(header.serve_id)}::uuid,input.position,${input.user_id}::uuid,input.repo_id,input.generation_id,
            input.legacy_generation_hint,input.record_digest,input.capture_status
          FROM input JOIN inserted_items USING(position,repo_id)
          RETURNING position,exposure_id
        `];
      }
      // Only a successfully committed, current scoped serve counts as backend
      // presence. Any later failure rolls this stamp back with the serve.
      if(lane)await tx`UPDATE telemetry.feed_intent_sessions
        SET last_presence_ms=GREATEST(last_presence_ms,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
        WHERE session_id=${input.session_id}::uuid AND user_id=${input.user_id}::uuid AND status='active'`;
      return {serve_id:String(header.serve_id),created_at:header.created_at,provenance};
    }).catch(error => {
      if (error?.code === 'P0001' && ['FEED_PROVENANCE_INVALID','SCORING_CAPTURE_EXPIRED'].includes(error.message)) throw new FeedProvenanceUnavailableError();
      if (error?.code === '58000' && error.message === 'FEED_PROVENANCE_UNAVAILABLE') throw new FeedProvenanceDependencyError();
      throw error;
    });
    if (!created || input.items.some(item => item.summary_id !== item.repository.summary_id)) {
      const replay = await this.getServeByRequest(input.user_id, input.feed_request_id);
      if (!replay) throw new FeedServeOverlapError();
      return replay;
    }
    // Creation uses the canonical projections already hydrated for this serve.
    // Replays/conflicts read current mutable product fields from storage.
    return {
      ...input,serve_id: String(created.serve_id),created_at: new Date(created.created_at as string).toISOString(),
      items: [...input.items].sort((a,b) => a.position-b.position).map(item => ({
        position: item.position,repo_id: item.repo_id,score: item.score,source: item.source,
        model_version: item.model_version,summary_id: item.summary_id,repository: item.repository,
        ...(item.generation_id ? {generation_id:item.generation_id} : {}),
        ...(item.legacy_generation_hint ? {legacy_generation_hint:item.legacy_generation_hint} : {}),
        ...(item.scoring_reference ? {scoring_reference:item.scoring_reference} : {}),
        exposure_id:String(created.provenance.find(row => Number(row.position)===item.position)!.exposure_id),
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
    return (await this.activeRepositoryRows(repoIds,viewerUserId)).map(row=>projection(row));
  }

  private async activeRepositoryRows(repoIds: string[], viewerUserId?: string,
    eligibility?: {text: string; parameters: readonly (string|string[])[]}) {
    if (repoIds.length === 0) return [];
    const rows = await sqlClient`
      ${eligibility ? sqlClient`WITH eligibility AS (${boundSql(eligibility.text,eligibility.parameters)})` : sqlClient.unsafe('')}
      SELECT ${eligibility ? sqlClient.unsafe('eligibility.preference_eligible,eligibility.exposure_eligible,eligibility.session_served,') : sqlClient.unsafe('')}
        ${sqlClient.unsafe(readmeSummaryProjection('repo','content'))},
             repo.repo_id, repo.full_name, repo.status, repo.updated_at, content.description,
             content.primary_language,content.languages,content.language_breakdown,content.language_total_size::float8 AS language_total_size,content.language_breakdown_complete,content.language_observed_at,content.readme,content.readme_source_path AS readme_source_path,
             content.readme_default_branch AS readme_default_branch,content.readme_base_url AS readme_base_url,
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
      ${eligibility ? sqlClient.unsafe('JOIN eligibility ON eligibility.repo_id=repo.repo_id') : sqlClient.unsafe('')}
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
    return rows;
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
      LEFT JOIN app.users feed_viewer ON feed_viewer.user_id=${viewerUserId ?? null}::uuid
      WHERE snapshot.complete AND snapshot.active AND repo.status='active'
        AND ${sqlClient.unsafe(unfamiliarRepositorySql('feed_viewer.user_id'))}
        AND NOT (item.repo_id = ANY(${excludeRepoIds}::uuid[]))
        AND NOT EXISTS (
          SELECT 1 FROM app.reactions negative WHERE negative.user_id=${viewerUserId ?? null}::uuid
            AND negative.repo_id=item.repo_id AND negative.reaction='dislike'
        )
        AND NOT EXISTS (
          SELECT 1 FROM telemetry.feed_serves recent_serve
          JOIN telemetry.feed_serve_items seen_item ON seen_item.serve_id=recent_serve.serve_id
          WHERE recent_serve.user_id=${viewerUserId ?? null}::uuid AND seen_item.repo_id=item.repo_id
            AND recent_serve.created_at>=now()-(${this.recentExposureDays * 86400}::integer * interval '1 second')
        )
        AND NOT EXISTS (
          SELECT 1 FROM telemetry.interaction_events recent_event
          WHERE recent_event.user_id=${viewerUserId ?? null}::uuid AND recent_event.repo_id=item.repo_id
            AND recent_event.server_received_at>=now()-(${this.recentExposureDays * 86400}::integer * interval '1 second')
        )
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
