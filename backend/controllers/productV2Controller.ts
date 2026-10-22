import { getReadmeSummaryStatus, readmeSummaryProjection } from '../services/readmeSummaryService.js';
import type { Response } from 'express';
import { sqlClient } from '../db/index.js';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import { buildMlOnboardingJob, hasMlEmbeddingContext } from '../services/mlOnboardingService.js';
import { setFollowRelationship } from '../services/followService.js';
import { setSocialProfileFollowing } from '../services/socialProfileService.js';
import { getRepositoryDetail } from '../services/repositoryDetailService.js';
import {
  addRepositoryToBoard,
  deleteRepositoryBoard,
  deleteRepositoryList,
  removeRepositoryFromBoard,
  syncRepositoryLists,
} from '../services/repositoryMembershipService.js';
import { isInteractionEventV2 } from '../utils/interactionValidation.js';
import { isValidDateOfBirth } from '../utils/dateOfBirth.js';
import { normalizeUsername } from '../utils/username.js';
import { isValidUuid } from '../utils/validators.js';
import { sendControllerError, sendError, sendSuccess } from '../utils/response.js';

const MAX_LIMIT = 100;
const MAX_OFFSET = 10_000;

function paging(req: AuthRequest): { limit: number; offset: number } | null {
  const limit = req.query.limit === undefined ? 25 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT
    && Number.isInteger(offset) && offset >= 0 && offset <= MAX_OFFSET ? { limit, offset } : null;
}

function text(value: unknown, max: number, required = false): string | null | undefined {
  if (value === null && !required) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) return undefined;
  return normalized;
}

function slugArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 50
    || !value.every((item) => typeof item === 'string' && item.trim().length <= 100)) return null;
  const normalized = value.map((item) => String(item).trim().toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 50)
    .replace(/-+$/g, ''));
  if (normalized.some((item) => !/^[a-z0-9][a-z0-9-]{0,49}$/.test(item))) return null;
  return [...new Set(normalized)];
}

function userId(req: AuthRequest, res: Response): string | null {
  const id = req.user?.userId;
  if (!id) sendError(res, 401, 'Authentication required.');
  return id ?? null;
}

function idParam(req: AuthRequest, res: Response, name: string): string | null {
  const raw = req.params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!isValidUuid(value)) sendError(res, 400, `${name} must be a UUID.`);
  return isValidUuid(value) ? value : null;
}

export function hasCompletedOnboarding(
  onboardingCompleted: unknown,
): boolean {
  // This explicit durable flag is the only routing authority. Inferring state
  // from a linked provider or partial topics can incorrectly bypass onboarding.
  return onboardingCompleted === true;
}

export async function getMe(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); if (!id) return;
  const rows = await sqlClient`
    SELECT u.user_id,u.username,u.full_name,u.date_of_birth,u.bio,u.github_id,u.github_handle,u.avatar_url,u.status,
      u.onboarding_completed,
      u.interests,u.skills,u.tech_stack,u.profile_version,u.created_at,u.updated_at,
      s.followers_count,s.following_count,s.likes_given_count,
      s.saved_repos_count,f.feed_version,f.feedback_version,
      COALESCE((SELECT json_agg(t.slug ORDER BY t.slug) FROM app.user_topics ut JOIN app.topics t USING(topic_id)
        WHERE ut.user_id=u.user_id),'[]'::json) AS topics
    FROM app.users u JOIN app.user_stats s USING(user_id) JOIN app.user_feed_state f USING(user_id)
    WHERE u.user_id=${id}::uuid AND u.status<>'deleted'`;
  if (!rows[0]) return sendError(res, 404, 'User profile not found.');
  sendSuccess(res, 200, {
    ...rows[0],
    onboarding_completed: hasCompletedOnboarding(rows[0].onboarding_completed),
  });
}

export async function getUser(req: AuthRequest, res: Response): Promise<void> {
  const viewer = userId(req, res); if (!viewer) return;
  const target = idParam(req, res, 'userId'); if (!target) return;
  const rows = await sqlClient`
    SELECT u.user_id,u.username,u.full_name,u.bio,u.github_handle,u.avatar_url,u.created_at,
      s.followers_count,s.following_count,s.likes_given_count,
      (${viewer}::uuid=u.user_id) AS is_self,
      EXISTS(
        SELECT 1 FROM app.follows viewer_follow
        WHERE viewer_follow.follower_id=${viewer}::uuid
          AND viewer_follow.following_id=u.user_id
      ) AS viewer_follows_user,
      COALESCE((SELECT json_agg(t.slug ORDER BY t.slug) FROM app.user_topics ut JOIN app.topics t USING(topic_id)
        WHERE ut.user_id=u.user_id),'[]'::json) AS topics
    FROM app.users u JOIN app.user_stats s USING(user_id)
    WHERE u.user_id=${target}::uuid AND u.status='active'`;
  if (!rows[0]) return sendError(res, 404, 'User not found.');
  sendSuccess(res, 200, rows[0]);
}

export async function updateMe(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); if (!id) return;
  const allowed = ['username', 'full_name', 'date_of_birth', 'bio', 'avatar_url'];
  if (!req.body || Object.keys(req.body).some((key) => !allowed.includes(key))) return sendError(res, 400, 'Unsupported profile field.');
  const usernameValue = req.body.username === undefined ? undefined : normalizeUsername(req.body.username) ?? undefined;
  const fullName = req.body.full_name === undefined ? undefined : text(req.body.full_name, 100);
  const dateOfBirth = req.body.date_of_birth === undefined ? undefined : req.body.date_of_birth;
  const bio = req.body.bio === undefined ? undefined : text(req.body.bio, 2_000);
  const avatarUrl = req.body.avatar_url === undefined ? undefined : text(req.body.avatar_url, 2_048);
  if ((req.body.username !== undefined && usernameValue === undefined)
    || (req.body.full_name !== undefined && fullName === undefined)
    || (req.body.date_of_birth !== undefined && !isValidDateOfBirth(dateOfBirth))
    || (req.body.bio !== undefined && bio === undefined)
    || (req.body.avatar_url !== undefined && avatarUrl === undefined)) {
    return sendError(res, 400, 'Invalid profile value.');
  }
  try {
    const updated = await sqlClient.begin(async (tx) => {
      const rows = await tx`
        UPDATE app.users SET username=COALESCE(${usernameValue ?? null},username),
          full_name=CASE WHEN ${req.body.full_name !== undefined} THEN ${fullName ?? null} ELSE full_name END,
          date_of_birth=CASE WHEN ${req.body.date_of_birth !== undefined} THEN ${dateOfBirth ?? null}::date ELSE date_of_birth END,
          bio=CASE WHEN ${req.body.bio !== undefined} THEN ${bio ?? null} ELSE bio END,
          avatar_url=CASE WHEN ${req.body.avatar_url !== undefined} THEN ${avatarUrl ?? null} ELSE avatar_url END,
          profile_version=profile_version+1,updated_at=now()
        WHERE user_id=${id}::uuid
        RETURNING user_id,username,full_name,date_of_birth,bio,github_handle,avatar_url,interests,skills,tech_stack,
          profile_version,updated_at`;
      if (!rows[0]) throw Object.assign(new Error('User profile not found.'), { statusCode: 404 });
      const job = buildMlOnboardingJob(id, Number(rows[0].profile_version), {
        username: String(rows[0].username),
        fullName: rows[0].full_name == null ? null : String(rows[0].full_name),
        bio: rows[0].bio == null ? null : String(rows[0].bio),
        githubUsername: rows[0].github_handle == null ? null : String(rows[0].github_handle),
        avatarUrl: rows[0].avatar_url == null ? null : String(rows[0].avatar_url),
        interests: Array.isArray(rows[0].interests) ? rows[0].interests.map(String) : [],
        skills: Array.isArray(rows[0].skills) ? rows[0].skills.map(String) : [],
        techStack: Array.isArray(rows[0].tech_stack) ? rows[0].tech_stack.map(String) : [],
      });
      if (hasMlEmbeddingContext(job.profile)) {
        await tx`
          INSERT INTO telemetry.ml_outbox(job_type,aggregate_id,idempotency_key,payload)
          VALUES('onboard',${id}::uuid,${`onboard:${id}:${rows[0].profile_version}`},${JSON.stringify(job)}::jsonb)
          ON CONFLICT (idempotency_key) DO NOTHING
        `;
      }
      return rows[0];
    });
    sendSuccess(res, 200, updated);
  } catch (error) { sendControllerError(res, error); }
}

export async function onboardingStatus(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); if (!id) return;
  const rows = await sqlClient`
    SELECT u.onboarding_completed,u.profile_version
    FROM app.users u WHERE u.user_id=${id}::uuid
  `;
  if (!rows[0]) return sendError(res, 404, 'User profile not found.');
  sendSuccess(res, 200, {
    completed: hasCompletedOnboarding(rows[0].onboarding_completed),
    profile_version: rows[0].profile_version,
  });
}

export async function completeOnboarding(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); if (!id) return;
  const bio = req.body?.bio === undefined ? null : text(req.body.bio, 2_000);
  const structured = ['interests', 'skills', 'tech_stack'].some((key) => Object.hasOwn(req.body ?? {}, key));
  const legacyTopics = structured ? [] : slugArray(req.body?.topics);
  const interests = structured ? slugArray(req.body?.interests ?? []) : legacyTopics;
  const skills = structured ? slugArray(req.body?.skills ?? []) : [];
  const techStack = structured ? slugArray(req.body?.tech_stack ?? []) : [];
  if (bio === undefined) return sendError(res, 400, 'Bio can contain at most 2000 characters.');
  if (interests === null || skills === null || techStack === null) {
    return sendError(res, 400, 'Each onboarding category can contain at most 50 valid selections.');
  }
  if (interests.length + skills.length + techStack.length < 1) {
    return sendError(res, 400, 'Choose at least one interest, skill, or technology.');
  }
  const uniqueTopics = [...new Set([...interests, ...skills, ...techStack])];
  if (uniqueTopics.length > 100) return sendError(res, 400, 'The combined onboarding profile may contain at most 100 unique slugs.');
  try {
    const result = await sqlClient.begin(async (tx) => {
      const profiles = await tx`
        SELECT username,full_name,date_of_birth
        FROM app.users
        WHERE user_id=${id}::uuid
        FOR UPDATE
      `;
      if (!profiles[0]) throw Object.assign(new Error('User profile not found.'), { statusCode: 404 });
      if (!profiles[0].username || !profiles[0].full_name || !profiles[0].date_of_birth) {
        throw Object.assign(
          new Error('Complete your full name, username, and date of birth before finishing onboarding.'),
          { statusCode: 400 },
        );
      }
      const updated = await tx`UPDATE app.users SET bio=COALESCE(${bio},bio),
        interests=${JSON.stringify(interests)}::jsonb,skills=${JSON.stringify(skills)}::jsonb,
        tech_stack=${JSON.stringify(techStack)}::jsonb,onboarding_completed=true,
        profile_version=profile_version+1,updated_at=now()
        WHERE user_id=${id}::uuid RETURNING profile_version,username,full_name,bio,github_handle,avatar_url`;
      if (!updated[0]) throw Object.assign(new Error('User profile not found.'), { statusCode: 404 });
      await tx`DELETE FROM app.user_topics WHERE user_id=${id}::uuid`;
      for (const slug of uniqueTopics) {
        const topic = await tx`INSERT INTO app.topics(slug,display_name) VALUES (${slug},${slug})
          ON CONFLICT(slug) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING topic_id`;
        await tx`INSERT INTO app.user_topics(user_id,topic_id) VALUES (${id}::uuid,${topic[0].topic_id})`;
      }
      const version = String(updated[0].profile_version);
      const job = buildMlOnboardingJob(id, Number(version), {
        username: String(updated[0].username),
        fullName: updated[0].full_name == null ? null : String(updated[0].full_name),
        bio: updated[0].bio == null ? null : String(updated[0].bio),
        githubUsername: updated[0].github_handle == null ? null : String(updated[0].github_handle),
        avatarUrl: updated[0].avatar_url == null ? null : String(updated[0].avatar_url),
        interests,
        skills,
        techStack,
      });
      await tx`INSERT INTO telemetry.ml_outbox(job_type,aggregate_id,idempotency_key,payload)
        VALUES('onboard',${id}::uuid,${`onboard:${id}:${version}`},${JSON.stringify(job)}::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING`;
      return { completed: true, profile_version: version, topics: uniqueTopics, interests, skills, tech_stack: techStack };
    });
    sendSuccess(res, 200, result);
  } catch (error) { sendControllerError(res, error); }
}

export async function setFollow(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const target = idParam(req, res, 'userId'); if (!id || !target) return;
  if (id === target) return sendError(res, 400, 'A user cannot follow themselves.');
  try {
    await setFollowRelationship({ followerId: id, followingId: target, following: true });
    res.status(204).end();
  } catch (error) { sendControllerError(res, error); }
}

export async function getSocialProfile(req: AuthRequest, res: Response): Promise<void> {
  const viewer = userId(req, res); if (!viewer) return;
  const profileId = idParam(req, res, 'profileId'); if (!profileId) return;
  const rows = await sqlClient`
    SELECT profile.profile_id,profile.provider,profile.provider_subject,profile.handle,
      COALESCE(claimed_user.full_name,profile.display_name) AS display_name,
      COALESCE(claimed_user.avatar_url,profile.avatar_url) AS avatar_url,
      claimed_user.username,claimed_user.bio,claimed_user.github_handle,
      profile.profile_kind,profile.claimed_by_user_id,
      profile.created_at,
      CASE
        WHEN claimed_stats.user_id IS NOT NULL THEN claimed_stats.followers_count
        ELSE (SELECT count(*)::int FROM app.social_profile_follows external_follow
              WHERE external_follow.profile_id=profile.profile_id)
      END AS followers_count,
      COALESCE(claimed_stats.following_count,0) AS following_count,
      COALESCE(claimed_stats.likes_given_count,0) AS likes_given_count,
      CASE
        WHEN profile.claimed_by_user_id IS NOT NULL THEN EXISTS(
          SELECT 1 FROM app.follows claimed_follow
          WHERE claimed_follow.follower_id=${viewer}::uuid
            AND claimed_follow.following_id=profile.claimed_by_user_id
        )
        ELSE EXISTS(
          SELECT 1 FROM app.social_profile_follows external_follow
          WHERE external_follow.follower_id=${viewer}::uuid
            AND external_follow.profile_id=profile.profile_id
        )
      END AS viewer_follows_profile,
      (profile.claimed_by_user_id=${viewer}::uuid) AS is_self,
      COALESCE((
        SELECT json_agg(json_build_object(
          'repo_id',repo.repo_id,
          'full_name',repo.full_name,
          'name',repo.name,
          'url',repo.url,
          'description',content.description,
          'star_count',COALESCE(stats.star_count,0),
          'fork_count',COALESCE(stats.fork_count,0)
        ) ORDER BY repo.updated_at DESC)
        FROM app.repos repo
        LEFT JOIN app.repo_content content ON content.repo_id=repo.repo_id
        LEFT JOIN LATERAL (
          SELECT snapshot.star_count,snapshot.fork_count
          FROM app.repo_stat_snapshots snapshot
          WHERE snapshot.repo_id=repo.repo_id
          ORDER BY snapshot.observed_at DESC
          LIMIT 1
        ) stats ON true
        WHERE repo.status='active'
          AND (
            (
              repo.owner_github_id IS NOT NULL
              AND profile.provider_subject=repo.owner_github_id::text
            )
            OR (
              repo.owner_github_id IS NULL
              AND lower(repo.owner)=lower(profile.handle)
            )
          )
      ),'[]'::json) AS repositories
    FROM app.social_profiles profile
    LEFT JOIN app.users claimed_user ON claimed_user.user_id=profile.claimed_by_user_id
    LEFT JOIN app.user_stats claimed_stats ON claimed_stats.user_id=profile.claimed_by_user_id
    WHERE profile.profile_id=${profileId}::uuid AND profile.status='active'
  `;
  if (!rows[0]) return sendError(res, 404, 'Profile not found.');
  sendSuccess(res, 200, rows[0]);
}

export async function setSocialProfileFollow(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const profileId = idParam(req, res, 'profileId');
  if (!id || !profileId) return;
  try {
    await setSocialProfileFollowing({ followerId: id, profileId, following: true });
    res.status(204).end();
  } catch (error) { sendControllerError(res, error); }
}

export async function removeSocialProfileFollow(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const profileId = idParam(req, res, 'profileId');
  if (!id || !profileId) return;
  try {
    await setSocialProfileFollowing({ followerId: id, profileId, following: false });
    res.status(204).end();
  } catch (error) { sendControllerError(res, error); }
}

export async function removeFollow(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const target = idParam(req, res, 'userId'); if (!id || !target) return;
  if (id === target) return sendError(res, 400, 'A user cannot unfollow themselves.');
  try {
    await setFollowRelationship({ followerId: id, followingId: target, following: false });
    res.status(204).end();
  } catch (error) { sendControllerError(res, error); }
}

async function followList(req: AuthRequest, res: Response, direction: 'followers' | 'following'): Promise<void> {
  const viewer = userId(req, res); if (!viewer) return;
  const target = idParam(req, res, 'userId'); const page = paging(req); if (!target) return;
  if (!page) return sendError(res, 400, 'limit must be 1-100 and offset must be 0-10000.');
  const rows = direction === 'followers'
    ? await sqlClient`
        SELECT u.user_id,NULL::uuid AS profile_id,u.username,u.full_name,u.avatar_url,f.created_at,
          EXISTS(SELECT 1 FROM app.follows viewer_follow
            WHERE viewer_follow.follower_id=${viewer}::uuid
              AND viewer_follow.following_id=u.user_id) AS viewer_follows_user,
          false AS viewer_follows_profile
        FROM app.follows f JOIN app.users u ON u.user_id=f.follower_id
        WHERE f.following_id=${target}::uuid AND u.status='active'
        ORDER BY f.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}
      `
    : await sqlClient`
        WITH followed_profiles AS (
          SELECT u.user_id,NULL::uuid AS profile_id,u.username,u.full_name,u.avatar_url,
            follow.created_at,
            EXISTS(SELECT 1 FROM app.follows viewer_follow
              WHERE viewer_follow.follower_id=${viewer}::uuid
                AND viewer_follow.following_id=u.user_id) AS viewer_follows_user,
            false AS viewer_follows_profile
          FROM app.follows follow
          JOIN app.users u ON u.user_id=follow.following_id
          WHERE follow.follower_id=${target}::uuid AND u.status='active'
          UNION ALL
          SELECT NULL::uuid AS user_id,profile.profile_id,profile.handle AS username,
            profile.display_name AS full_name,profile.avatar_url,follow.created_at,
            false AS viewer_follows_user,
            EXISTS(SELECT 1 FROM app.social_profile_follows viewer_follow
              WHERE viewer_follow.follower_id=${viewer}::uuid
                AND viewer_follow.profile_id=profile.profile_id) AS viewer_follows_profile
          FROM app.social_profile_follows follow
          JOIN app.social_profiles profile ON profile.profile_id=follow.profile_id
          WHERE follow.follower_id=${target}::uuid
            AND profile.status='active'
            AND profile.claimed_by_user_id IS NULL
        )
        SELECT * FROM followed_profiles
        ORDER BY created_at DESC
        LIMIT ${page.limit} OFFSET ${page.offset}
      `;
  sendSuccess(res, 200, { items: rows, ...page });
}
export const listFollowers = (req: AuthRequest, res: Response) => followList(req, res, 'followers');
export const listFollowing = (req: AuthRequest, res: Response) => followList(req, res, 'following');

// Optional summary/README metadata is read through JSON until migration 0024 is deployed.
// Missing provenance excludes legacy text so it can never appear as a concise Summary.
export async function listLikesGiven(req: AuthRequest, res: Response): Promise<void> {
  const viewer = userId(req, res); const target = idParam(req, res, 'userId'); const page = paging(req);
  if (!viewer || !target) return;
  if (!page) return sendError(res, 400, 'limit must be 1-100 and offset must be 0-10000.');
  const rows = await sqlClient`
    SELECT r.repo_id,r.github_id,r.owner_github_id,r.url AS github_repo_url,
      r.owner AS owner_id,r.name AS repo_name,r.full_name,r.owner,r.name,r.url,r.status,
      r.created_at,r.updated_at,c.description,c.languages AS language_used,
      c.primary_language,c.languages,${sqlClient.unsafe(readmeSummaryProjection('r','c'))},to_jsonb(c)->>'readme_source_path' AS readme_source_path,
      to_jsonb(c)->>'readme_default_branch' AS readme_default_branch,to_jsonb(c)->>'readme_base_url' AS readme_base_url,c.content_version,
      c.updated_at AS content_updated_at,c.source_updated_at,
      COALESCE((SELECT json_agg(t.slug ORDER BY t.slug) FROM app.repo_topics rt JOIN app.topics t USING(topic_id)
        WHERE rt.repo_id=r.repo_id),'[]'::json) AS topics,
      e.likes_count,e.dislikes_count,e.saves_count,e.comments_count,e.views_count,
      COALESCE(s.star_count,0) AS star_count,COALESCE(s.fork_count,0) AS forks_count,
      COALESCE(s.fork_count,0) AS fork_count,COALESCE(s.open_issues_count,0) AS open_issues_count,
      s.observed_at AS stats_observed_at,summary.summary_id,summary.summary,
      summary.highlights AS summary_highlights,summary.prompt_version AS summary_prompt_version,
      summary.model_version AS summary_model_version,
      summary.format_version AS summary_format_version,summary.source AS summary_source,
      viewer_reaction.reaction AS viewer_reaction,
      (viewer_save.repo_id IS NOT NULL) AS viewer_saved,
      COALESCE((SELECT json_agg(selection.list_id ORDER BY selection.list_id) FROM (
        SELECT 'collection:' || collection.collection_id::text AS list_id
        FROM app.collection_repos membership
        JOIN app.board_collections collection USING(collection_id)
        WHERE membership.repo_id=r.repo_id AND collection.user_id=${viewer}::uuid
        UNION ALL
        SELECT 'legacy-board:' || board.board_id::text AS list_id
        FROM app.board_repos membership JOIN app.boards board USING(board_id)
        WHERE membership.repo_id=r.repo_id AND board.user_id=${viewer}::uuid
      ) selection),'[]'::json) AS selected_list_ids
    FROM app.reactions reaction JOIN app.repos r USING(repo_id)
    JOIN app.repo_content c USING(repo_id) JOIN app.repo_engagement e USING(repo_id)
    LEFT JOIN LATERAL (SELECT star_count,fork_count,open_issues_count,observed_at FROM app.repo_stat_snapshots snapshot
      WHERE snapshot.repo_id=r.repo_id ORDER BY observed_at DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT card.summary_id,card.summary,to_jsonb(card)->'highlights' AS highlights,
      to_jsonb(card)->>'prompt_version' AS prompt_version,card.model_version,
      to_jsonb(card)->>'format_version' AS format_version,to_jsonb(card)->>'source' AS source
      FROM app.repo_card_summaries card
      WHERE card.repo_id=r.repo_id AND active AND card.content_version=c.content_version
        AND to_jsonb(card)->>'source' IN ('generated','description_fallback')
      ORDER BY created_at DESC LIMIT 1) summary ON true
    LEFT JOIN app.reactions viewer_reaction
      ON viewer_reaction.repo_id=r.repo_id AND viewer_reaction.user_id=${viewer}::uuid
    LEFT JOIN app.saves viewer_save
      ON viewer_save.repo_id=r.repo_id AND viewer_save.user_id=${viewer}::uuid
    WHERE reaction.user_id=${target}::uuid AND reaction.reaction='like' AND r.status='active'
    ORDER BY reaction.updated_at DESC LIMIT ${page.limit} OFFSET ${page.offset}
  `;
  sendSuccess(res, 200, { items: rows, ...page });
}

const repoProjection = `r.repo_id,r.github_id,r.full_name,r.owner,r.name,r.url,c.description,c.primary_language,c.languages,c.content_version,
  e.likes_count,e.dislikes_count,e.saves_count,e.comments_count,e.views_count,
  s.star_count,s.fork_count,s.open_issues_count,s.observed_at,cs.summary,cs.model_version`;

export async function listRepositories(req: AuthRequest, res: Response): Promise<void> {
  const viewer = userId(req, res); if (!viewer) return;
  const page = paging(req); if (!page) return sendError(res, 400, 'Invalid pagination.');
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const rows = await sqlClient.unsafe(`SELECT ${repoProjection},r.owner_github_id,r.status,r.created_at,r.updated_at,
    ${readmeSummaryProjection('r','c')},to_jsonb(c)->>'readme_source_path' AS readme_source_path,to_jsonb(c)->>'readme_default_branch' AS readme_default_branch,to_jsonb(c)->>'readme_base_url' AS readme_base_url,
    c.updated_at AS content_updated_at,c.source_updated_at,
    s.observed_at AS stats_observed_at,
    owner_profile.profile_id AS owner_profile_id,
    owner_profile.claimed_by_user_id AS owner_user_id,
    owner_profile.claimed_by_user_id AS owner_profile_claimed_user_id,
    owner_profile.profile_kind AS owner_profile_kind,
    COALESCE(owner_user.username,owner_profile.handle) AS owner_username,
    COALESCE(owner_user.full_name,owner_profile.display_name,r.owner) AS owner_display_name,
    COALESCE(owner_user.avatar_url,owner_profile.avatar_url) AS owner_avatar_url,
    owner_user.bio AS owner_bio,
    CASE WHEN owner_profile.claimed_by_user_id IS NOT NULL THEN owner_follow.following_id IS NOT NULL
      WHEN owner_profile.profile_id IS NOT NULL THEN external_owner_follow.profile_id IS NOT NULL
      ELSE NULL END AS viewer_follows_owner,
    cs.summary_id,cs.highlights AS summary_highlights,
    cs.prompt_version AS summary_prompt_version,cs.model_version AS summary_model_version,
    cs.format_version AS summary_format_version,cs.source AS summary_source,
    COALESCE((SELECT json_agg(topic.slug ORDER BY topic.slug)
      FROM app.repo_topics repository_topic JOIN app.topics topic USING(topic_id)
      WHERE repository_topic.repo_id=r.repo_id),'[]'::json) AS topics,
    viewer_reaction.reaction AS viewer_reaction,
    (viewer_save.repo_id IS NOT NULL) AS viewer_saved,
    COALESCE((SELECT json_agg(selection.list_id ORDER BY selection.list_id) FROM (
      SELECT 'collection:' || collection.collection_id::text AS list_id
      FROM app.collection_repos membership JOIN app.board_collections collection USING(collection_id)
      WHERE membership.repo_id=r.repo_id AND collection.user_id=$4::uuid
      UNION ALL
      SELECT 'legacy-board:' || board.board_id::text AS list_id
      FROM app.board_repos membership JOIN app.boards board USING(board_id)
      WHERE membership.repo_id=r.repo_id AND board.user_id=$4::uuid
    ) selection),'[]'::json) AS selected_list_ids
    FROM app.repos r
    JOIN app.repo_content c USING(repo_id) JOIN app.repo_engagement e USING(repo_id)
    LEFT JOIN LATERAL (SELECT * FROM app.repo_stat_snapshots x WHERE x.repo_id=r.repo_id ORDER BY observed_at DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT x.summary_id,x.summary,to_jsonb(x)->'highlights' AS highlights,
      to_jsonb(x)->>'prompt_version' AS prompt_version,x.model_version,
      to_jsonb(x)->>'format_version' AS format_version,to_jsonb(x)->>'source' AS source
      FROM app.repo_card_summaries x WHERE x.repo_id=r.repo_id AND active
        AND x.content_version=c.content_version
        AND to_jsonb(x)->>'source' IN ('generated','description_fallback') ORDER BY created_at DESC LIMIT 1) cs ON true
    LEFT JOIN LATERAL (
      SELECT profile.profile_id,profile.claimed_by_user_id,profile.handle,profile.display_name,profile.avatar_url,profile.profile_kind
      FROM app.social_profiles profile WHERE profile.provider='github' AND profile.status='active'
        AND ((r.owner_github_id IS NOT NULL AND profile.provider_subject=r.owner_github_id::text)
          OR (r.owner_github_id IS NULL AND lower(profile.handle)=lower(r.owner)))
      ORDER BY (profile.claimed_by_user_id IS NOT NULL) DESC,profile.created_at ASC LIMIT 1
    ) owner_profile ON true
    LEFT JOIN app.users owner_user ON owner_user.user_id=owner_profile.claimed_by_user_id
    LEFT JOIN app.follows owner_follow ON owner_follow.follower_id=$4::uuid AND owner_follow.following_id=owner_profile.claimed_by_user_id
    LEFT JOIN app.social_profile_follows external_owner_follow ON external_owner_follow.follower_id=$4::uuid
      AND external_owner_follow.profile_id=owner_profile.profile_id AND owner_profile.claimed_by_user_id IS NULL
    LEFT JOIN app.reactions viewer_reaction ON viewer_reaction.repo_id=r.repo_id AND viewer_reaction.user_id=$4::uuid
    LEFT JOIN app.saves viewer_save ON viewer_save.repo_id=r.repo_id AND viewer_save.user_id=$4::uuid
    WHERE r.status='active' AND ($1='' OR r.full_name ILIKE '%'||$1||'%' OR COALESCE(c.description,'') ILIKE '%'||$1||'%')
    ORDER BY r.updated_at DESC,r.repo_id LIMIT $2 OFFSET $3`, [q, page.limit, page.offset, viewer]);
  sendSuccess(res, 200, { items: rows, ...page });
}

export async function getRepositoryReadmeSummary(req: AuthRequest, res: Response): Promise<void> {
  const viewer=userId(req,res); const repo=idParam(req,res,'repoId');
  if (!viewer || !repo) return;
  const result=await getReadmeSummaryStatus(repo);
  if (!result) return sendError(res,404,'Repository not found.');
  sendSuccess(res,200,result);
}

export async function getRepository(req: AuthRequest, res: Response): Promise<void> {
  const viewer = userId(req, res); const repo = idParam(req, res, 'repoId');
  if (!viewer || !repo) return;
  try {
    const detail = await getRepositoryDetail(viewer, repo);
    if (!detail) return sendError(res, 404, 'Repository not found.');
    sendSuccess(res, 200, detail);
  } catch (error) { sendControllerError(res, error); }
}

export async function getRepositoryShare(req: AuthRequest, res: Response): Promise<void> {
  const repo = idParam(req, res, 'repoId'); if (!repo) return;
  try {
    const rows = await sqlClient`
      SELECT r.repo_id,r.name,r.full_name,r.url,c.description
      FROM app.repos r JOIN app.repo_content c USING(repo_id)
      WHERE r.repo_id=${repo}::uuid AND r.status='active'
    `;
    if (!rows[0]) return sendError(res, 404, 'Repository not found.');
    sendSuccess(res, 200, rows[0]);
  } catch (error) { sendControllerError(res, error); }
}

export { listTrending } from './trendingController.js';

export async function listSaved(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const page = paging(req); if (!id) return;
  if (!page) return sendError(res, 400, 'Invalid pagination.');
  const rows = await sqlClient`SELECT s.created_at,s.created_at AS saved_at,r.repo_id,r.github_id,r.owner_github_id,
    r.full_name,r.owner,r.name,r.url,r.status,r.created_at AS repository_created_at,r.updated_at,
    c.description,c.primary_language,c.languages,${sqlClient.unsafe(readmeSummaryProjection('r','c'))},to_jsonb(c)->>'readme_source_path' AS readme_source_path,
    to_jsonb(c)->>'readme_default_branch' AS readme_default_branch,to_jsonb(c)->>'readme_base_url' AS readme_base_url,c.content_version,
    c.updated_at AS content_updated_at,c.source_updated_at,
    e.likes_count,e.dislikes_count,e.saves_count,e.comments_count,e.views_count,
    COALESCE(stat.star_count,0) AS star_count,COALESCE(stat.fork_count,0) AS fork_count,
    COALESCE(stat.open_issues_count,0) AS open_issues_count,stat.observed_at AS stats_observed_at,
    summary.summary_id,summary.summary,summary.highlights AS summary_highlights,
    summary.prompt_version AS summary_prompt_version,summary.model_version AS summary_model_version,
    summary.format_version AS summary_format_version,summary.source AS summary_source,
    COALESCE((SELECT json_agg(topic.slug ORDER BY topic.slug)
      FROM app.repo_topics repository_topic JOIN app.topics topic USING(topic_id)
      WHERE repository_topic.repo_id=r.repo_id),'[]'::json) AS topics,
    viewer_reaction.reaction AS viewer_reaction,true AS viewer_saved,
    COALESCE((SELECT json_agg(selection.list_id ORDER BY selection.list_id) FROM (
      SELECT 'collection:' || collection.collection_id::text AS list_id
      FROM app.collection_repos membership JOIN app.board_collections collection USING(collection_id)
      WHERE membership.repo_id=r.repo_id AND collection.user_id=${id}::uuid
      UNION ALL
      SELECT 'legacy-board:' || board.board_id::text AS list_id
      FROM app.board_repos membership JOIN app.boards board USING(board_id)
      WHERE membership.repo_id=r.repo_id AND board.user_id=${id}::uuid
    ) selection),'[]'::json) AS selected_list_ids
    FROM app.saves s JOIN app.repos r USING(repo_id) JOIN app.repo_content c USING(repo_id)
    JOIN app.repo_engagement e USING(repo_id)
    LEFT JOIN LATERAL (SELECT star_count,fork_count,open_issues_count,observed_at FROM app.repo_stat_snapshots x
      WHERE x.repo_id=r.repo_id ORDER BY observed_at DESC LIMIT 1) stat ON true
    LEFT JOIN LATERAL (SELECT x.summary_id,x.summary,to_jsonb(x)->'highlights' AS highlights,
      to_jsonb(x)->>'prompt_version' AS prompt_version,x.model_version,
      to_jsonb(x)->>'format_version' AS format_version,to_jsonb(x)->>'source' AS source
      FROM app.repo_card_summaries x WHERE x.repo_id=r.repo_id AND active
        AND x.content_version=c.content_version
        AND to_jsonb(x)->>'source' IN ('generated','description_fallback') ORDER BY created_at DESC LIMIT 1) summary ON true
    LEFT JOIN app.reactions viewer_reaction
      ON viewer_reaction.repo_id=r.repo_id AND viewer_reaction.user_id=${id}::uuid
    WHERE s.user_id=${id}::uuid AND r.status='active' ORDER BY s.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`;
  sendSuccess(res, 200, { items: rows, ...page });
}

export async function listComments(req: AuthRequest, res: Response): Promise<void> {
  const repo = idParam(req, res, 'repoId'); const page = paging(req); if (!repo) return;
  if (!page) return sendError(res, 400, 'Invalid pagination.');
  const rows = await sqlClient`SELECT c.comment_id,c.repo_id,c.parent_comment_id,c.body,c.created_at,c.updated_at,
    u.user_id,u.username,u.full_name,u.avatar_url FROM app.comments c JOIN app.users u USING(user_id)
    WHERE c.repo_id=${repo}::uuid AND u.status='active' ORDER BY c.created_at ASC LIMIT ${page.limit} OFFSET ${page.offset}`;
  sendSuccess(res, 200, { items: rows, ...page });
}

export async function createComment(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const repo = idParam(req, res, 'repoId'); if (!id || !repo) return;
  const body = text(req.body?.body, 5_000, true); const parent = req.body?.parent_comment_id ?? null;
  if (body === undefined || (parent !== null && !isValidUuid(parent))) return sendError(res, 400, 'Invalid comment.');
  try {
    const rows = await sqlClient.begin(async (tx) => {
      if (parent) {
        const match = await tx`SELECT 1 FROM app.comments WHERE comment_id=${parent}::uuid AND repo_id=${repo}::uuid`;
        if (!match.length) throw Object.assign(new Error('Parent comment not found in this repository.'), { statusCode: 400 });
      }
      const created = await tx`INSERT INTO app.comments(user_id,repo_id,parent_comment_id,body)
        VALUES(${id}::uuid,${repo}::uuid,${parent}::uuid,${body}) RETURNING *`;
      await tx`UPDATE app.repo_engagement SET comments_count=comments_count+1,updated_at=now() WHERE repo_id=${repo}::uuid`;
      return created;
    });
    sendSuccess(res, 201, rows[0]);
  } catch (error) { sendControllerError(res, error); }
}

export async function updateComment(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const comment = idParam(req, res, 'commentId'); if (!id || !comment) return;
  const body = text(req.body?.body, 5_000, true); if (body === undefined) return sendError(res, 400, 'Invalid comment body.');
  const rows = await sqlClient`UPDATE app.comments SET body=${body},updated_at=now() WHERE comment_id=${comment}::uuid AND user_id=${id}::uuid RETURNING *`;
  if (!rows[0]) return sendError(res, 404, 'Comment not found or not owned by user.');
  sendSuccess(res, 200, rows[0]);
}

export async function deleteComment(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const comment = idParam(req, res, 'commentId'); if (!id || !comment) return;
  const rows = await sqlClient.begin(async (tx) => {
    const tree = await tx`WITH RECURSIVE descendants AS (
      SELECT comment_id,repo_id FROM app.comments WHERE comment_id=${comment}::uuid AND user_id=${id}::uuid
      UNION ALL SELECT c.comment_id,c.repo_id FROM app.comments c JOIN descendants d ON c.parent_comment_id=d.comment_id
    ) SELECT comment_id,repo_id FROM descendants`;
    if (!tree[0]) return tree;
    await tx`DELETE FROM app.comments WHERE comment_id=${comment}::uuid AND user_id=${id}::uuid`;
    await tx`UPDATE app.repo_engagement SET comments_count=GREATEST(0,comments_count-${tree.length}),updated_at=now() WHERE repo_id=${tree[0].repo_id}`;
    return tree;
  });
  if (!rows[0]) return sendError(res, 404, 'Comment not found or not owned by user.');
  res.status(204).end();
}

type Resource = 'collection' | 'board';
async function listOwned(req: AuthRequest, res: Response, resource: Resource): Promise<void> {
  const id = userId(req, res); if (!id) return;
  const requestedRepo = typeof req.query.repository_id === 'string' ? req.query.repository_id : null;
  if (requestedRepo && !isValidUuid(requestedRepo)) return sendError(res, 400, 'repository_id must be a UUID.');
  const rows = resource === 'collection'
    ? requestedRepo
      ? await sqlClient`
          SELECT c.*,
            (SELECT count(*)::int FROM app.boards b WHERE b.collection_id=c.collection_id) AS board_count,
            (SELECT count(*)::int FROM app.collection_repos cr WHERE cr.collection_id=c.collection_id) AS repo_count,
            EXISTS(SELECT 1 FROM app.collection_repos cr WHERE cr.collection_id=c.collection_id AND cr.repo_id=${requestedRepo}::uuid) AS selected,
            (SELECT max(cr.added_at) FROM app.collection_repos cr WHERE cr.collection_id=c.collection_id) AS last_updated_at
          FROM app.board_collections c WHERE c.user_id=${id}::uuid
          ORDER BY c.updated_at DESC,c.created_at DESC
        `
      : await sqlClient`
          SELECT c.*,
            (SELECT count(*)::int FROM app.boards b WHERE b.collection_id=c.collection_id) AS board_count,
            (SELECT count(*)::int FROM app.collection_repos cr WHERE cr.collection_id=c.collection_id) AS repo_count,
            false AS selected,
            (SELECT max(cr.added_at) FROM app.collection_repos cr WHERE cr.collection_id=c.collection_id) AS last_updated_at
          FROM app.board_collections c WHERE c.user_id=${id}::uuid
          ORDER BY c.updated_at DESC,c.created_at DESC
        `
    : requestedRepo
      ? await sqlClient`
          SELECT b.*,count(br.repo_id)::int AS repo_count,
            EXISTS(
              SELECT 1 FROM app.board_repos selected
              WHERE selected.board_id=b.board_id AND selected.repo_id=${requestedRepo}::uuid
            ) AS selected
          FROM app.boards b LEFT JOIN app.board_repos br USING(board_id)
          WHERE b.user_id=${id}::uuid
          GROUP BY b.board_id ORDER BY b.created_at DESC
        `
      : await sqlClient`
          SELECT b.*,count(br.repo_id)::int AS repo_count,false AS selected
          FROM app.boards b LEFT JOIN app.board_repos br USING(board_id)
          WHERE b.user_id=${id}::uuid
          GROUP BY b.board_id ORDER BY b.created_at DESC
        `;
  sendSuccess(res, 200, { items: rows });
}
export const listCollections = (req: AuthRequest, res: Response) => listOwned(req, res, 'collection');
export const listBoards = (req: AuthRequest, res: Response) => listOwned(req, res, 'board');

export async function createCollection(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); if (!id) return;
  const name = text(req.body?.name, 100, true);
  const description = text(req.body?.description ?? null, 1_000);
  const icon = text(req.body?.icon ?? null, 16);
  const color = text(req.body?.color ?? null, 7);
  if (name === undefined || description === undefined || icon === undefined || color === undefined
    || (color !== null && !/^#[0-9A-Fa-f]{6}$/.test(color))) return sendError(res, 400, 'Invalid collection.');
  try {
    const rows = await sqlClient`
      INSERT INTO app.board_collections(user_id,name,description,icon,color)
      VALUES(${id}::uuid,${name},${description},${icon},${color}) RETURNING *
    `;
    sendSuccess(res, 201, { ...rows[0], board_count: 0, repo_count: 0, selected: false, last_updated_at: null });
  } catch (error) { sendControllerError(res, error); }
}

export async function saveRepositoryCollections(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); if (!id) return;
  const repositoryId = req.body?.repositoryId;
  const rawCollectionIds = req.body?.collectionIds;
  const rawBoardIds = Object.hasOwn(req.body ?? {}, 'boardIds') ? req.body.boardIds : undefined;
  if (!isValidUuid(repositoryId) || !Array.isArray(rawCollectionIds) || (rawBoardIds !== undefined && !Array.isArray(rawBoardIds))
    || rawCollectionIds.length + (rawBoardIds?.length ?? 0) > 100
    || !rawCollectionIds.every((value) => isValidUuid(value))
    || (rawBoardIds !== undefined && !rawBoardIds.every((value: unknown) => typeof value === 'string' && isValidUuid(value)))) {
    return sendError(res, 400, 'repositoryId must be a UUID and List IDs must contain at most 100 UUIDs.');
  }
  const collectionIds = [...new Set(rawCollectionIds as string[])];
  const boardIds = rawBoardIds === undefined ? undefined : [...new Set(rawBoardIds as string[])];
  const event = req.body?.event;
  if (event !== undefined && (!isInteractionEventV2(event)
    || (event.event_type !== 'save' && event.event_type !== 'unsave')
    || event.repo_id !== repositoryId)) {
    return sendError(res, 400, 'event must be a stable v2 save or unsave event matching repositoryId.');
  }
  try {
    const result = await syncRepositoryLists(id, repositoryId, collectionIds, boardIds, event);
    sendSuccess(res, 200, result);
  } catch (error) { sendControllerError(res, error); }
}

export async function updateCollection(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const collection = idParam(req, res, 'collectionId'); if (!id || !collection) return;
  const name = text(req.body?.name, 100, true); const description = text(req.body?.description ?? null, 1_000);
  const icon = text(req.body?.icon ?? null, 16); const color = text(req.body?.color ?? null, 7);
  if (name === undefined || description === undefined || icon === undefined || color === undefined
    || (color !== null && !/^#[0-9A-Fa-f]{6}$/.test(color))) return sendError(res, 400, 'Invalid collection.');
  try {
    const rows = await sqlClient`
      UPDATE app.board_collections SET name=${name},description=${description},icon=${icon},color=${color},updated_at=now()
      WHERE collection_id=${collection}::uuid AND user_id=${id}::uuid RETURNING *
    `;
    if (!rows[0]) return sendError(res, 404, 'Collection not found.'); sendSuccess(res, 200, rows[0]);
  } catch (error) { sendControllerError(res, error); }
}

export async function deleteCollection(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const collection = idParam(req, res, 'collectionId'); if (!id || !collection) return;
  try {
    const deleted = await deleteRepositoryList(id, collection);
    if (!deleted) return sendError(res, 404, 'Collection not found.');
    res.status(204).end();
  } catch (error) { sendControllerError(res, error); }
}

export async function listCollectionRepos(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const collection = idParam(req, res, 'collectionId'); if (!id || !collection) return;
  const owned = await sqlClient`
    SELECT 1 FROM app.board_collections
    WHERE collection_id=${collection}::uuid AND user_id=${id}::uuid
  `;
  if (!owned.length) return sendError(res, 404, 'Collection not found.');
  const rows = await sqlClient`
    SELECT cr.added_at,r.repo_id,r.github_id,r.owner_github_id,r.full_name,r.owner,r.name,r.url,
      r.status,r.created_at,r.updated_at,c.description,c.primary_language,c.languages,
      ${sqlClient.unsafe(readmeSummaryProjection('r','c'))},to_jsonb(c)->>'readme_source_path' AS readme_source_path,to_jsonb(c)->>'readme_default_branch' AS readme_default_branch,to_jsonb(c)->>'readme_base_url' AS readme_base_url,
      c.content_version,c.updated_at AS content_updated_at,c.source_updated_at,
      e.likes_count,e.dislikes_count,e.saves_count,e.comments_count,e.views_count,
      COALESCE(stat.star_count,0) AS star_count,COALESCE(stat.fork_count,0) AS fork_count,
      COALESCE(stat.open_issues_count,0) AS open_issues_count,stat.observed_at AS stats_observed_at,
      summary.summary_id,summary.summary,summary.highlights AS summary_highlights,
      summary.prompt_version AS summary_prompt_version,summary.model_version AS summary_model_version,
      summary.format_version AS summary_format_version,summary.source AS summary_source,
      COALESCE((SELECT json_agg(topic.slug ORDER BY topic.slug)
        FROM app.repo_topics repository_topic JOIN app.topics topic USING(topic_id)
        WHERE repository_topic.repo_id=r.repo_id),'[]'::json) AS topics,
      viewer_reaction.reaction AS viewer_reaction,
      (viewer_save.repo_id IS NOT NULL) AS viewer_saved,
      COALESCE((SELECT json_agg(selection.list_id ORDER BY selection.list_id) FROM (
        SELECT 'collection:' || viewer_list.collection_id::text AS list_id
        FROM app.collection_repos viewer_membership
        JOIN app.board_collections viewer_list USING(collection_id)
        WHERE viewer_membership.repo_id=r.repo_id AND viewer_list.user_id=${id}::uuid
        UNION ALL
        SELECT 'legacy-board:' || viewer_board.board_id::text AS list_id
        FROM app.board_repos viewer_membership JOIN app.boards viewer_board USING(board_id)
        WHERE viewer_membership.repo_id=r.repo_id AND viewer_board.user_id=${id}::uuid
      ) selection),'[]'::json) AS selected_list_ids
    FROM app.collection_repos cr
    JOIN app.repos r USING(repo_id)
    JOIN app.repo_content c USING(repo_id)
    JOIN app.repo_engagement e USING(repo_id)
    LEFT JOIN LATERAL (SELECT star_count,fork_count,open_issues_count,observed_at
      FROM app.repo_stat_snapshots snapshot WHERE snapshot.repo_id=r.repo_id
      ORDER BY observed_at DESC LIMIT 1) stat ON true
    LEFT JOIN LATERAL (SELECT card.summary_id,card.summary,to_jsonb(card)->'highlights' AS highlights,
      to_jsonb(card)->>'prompt_version' AS prompt_version,card.model_version,
      to_jsonb(card)->>'format_version' AS format_version,to_jsonb(card)->>'source' AS source
      FROM app.repo_card_summaries card WHERE card.repo_id=r.repo_id AND active
        AND card.content_version=c.content_version
        AND to_jsonb(card)->>'source' IN ('generated','description_fallback') ORDER BY created_at DESC LIMIT 1) summary ON true
    LEFT JOIN app.reactions viewer_reaction
      ON viewer_reaction.repo_id=r.repo_id AND viewer_reaction.user_id=${id}::uuid
    LEFT JOIN app.saves viewer_save
      ON viewer_save.repo_id=r.repo_id AND viewer_save.user_id=${id}::uuid
    WHERE cr.collection_id=${collection}::uuid AND r.status='active'
    ORDER BY cr.added_at DESC
  `;
  sendSuccess(res, 200, { items: rows });
}

export async function createBoard(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); if (!id) return; const name = text(req.body?.name, 100, true); const description = text(req.body?.description ?? null, 1_000);
  const visibility = req.body?.visibility ?? 'private'; const collection = req.body?.collection_id ?? null;
  if (name === undefined || description === undefined || !['private','public','unlisted'].includes(visibility) || (collection && !isValidUuid(collection))) return sendError(res, 400, 'Invalid board.');
  if (collection) { const owned = await sqlClient`SELECT 1 FROM app.board_collections WHERE collection_id=${collection}::uuid AND user_id=${id}::uuid`; if (!owned.length) return sendError(res, 400, 'Collection not found.'); }
  const rows = await sqlClient`INSERT INTO app.boards(user_id,collection_id,name,description,visibility) VALUES(${id}::uuid,${collection}::uuid,${name},${description},${visibility}) RETURNING *`;
  sendSuccess(res, 201, rows[0]);
}

export async function updateBoard(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const board = idParam(req, res, 'boardId'); if (!id || !board) return;
  const name = text(req.body?.name, 100, true); const description = text(req.body?.description ?? null, 1_000); const visibility = req.body?.visibility;
  const collection = req.body?.collection_id ?? null;
  if (name === undefined || description === undefined || !['private','public','unlisted'].includes(visibility) || (collection && !isValidUuid(collection))) return sendError(res, 400, 'Invalid board.');
  if (collection) { const owned = await sqlClient`SELECT 1 FROM app.board_collections WHERE collection_id=${collection}::uuid AND user_id=${id}::uuid`; if (!owned.length) return sendError(res, 400, 'Collection not found.'); }
  const rows = await sqlClient`UPDATE app.boards SET name=${name},description=${description},visibility=${visibility},collection_id=${collection}::uuid WHERE board_id=${board}::uuid AND user_id=${id}::uuid RETURNING *`;
  if (!rows[0]) return sendError(res, 404, 'Board not found.'); sendSuccess(res, 200, rows[0]);
}

export async function deleteBoard(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const board = idParam(req, res, 'boardId'); if (!id || !board) return;
  try {
    const deleted = await deleteRepositoryBoard(id, board);
    if (!deleted) return sendError(res, 404, 'Board not found.');
    res.status(204).end();
  } catch (error) { sendControllerError(res, error); }
}

export async function listBoardRepos(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const board = idParam(req, res, 'boardId'); if (!id || !board) return;
  const allowed = await sqlClient`SELECT 1 FROM app.boards WHERE board_id=${board}::uuid AND (user_id=${id}::uuid OR visibility IN ('public','unlisted'))`;
  if (!allowed.length) return sendError(res, 404, 'Board not found.');
  const rows = await sqlClient`
    SELECT br.added_at,r.repo_id,r.github_id,r.owner_github_id,r.full_name,r.owner,r.name,r.url,
      r.status,r.created_at,r.updated_at,c.description,c.primary_language,c.languages,
      ${sqlClient.unsafe(readmeSummaryProjection('r','c'))},to_jsonb(c)->>'readme_source_path' AS readme_source_path,to_jsonb(c)->>'readme_default_branch' AS readme_default_branch,to_jsonb(c)->>'readme_base_url' AS readme_base_url,
      c.content_version,c.updated_at AS content_updated_at,c.source_updated_at,
      e.likes_count,e.dislikes_count,e.saves_count,e.comments_count,e.views_count,
      COALESCE(stat.star_count,0) AS star_count,COALESCE(stat.fork_count,0) AS fork_count,
      COALESCE(stat.open_issues_count,0) AS open_issues_count,stat.observed_at AS stats_observed_at,
      summary.summary_id,summary.summary,summary.highlights AS summary_highlights,
      summary.prompt_version AS summary_prompt_version,summary.model_version AS summary_model_version,
      summary.format_version AS summary_format_version,summary.source AS summary_source,
      COALESCE((SELECT json_agg(topic.slug ORDER BY topic.slug)
        FROM app.repo_topics repository_topic JOIN app.topics topic USING(topic_id)
        WHERE repository_topic.repo_id=r.repo_id),'[]'::json) AS topics,
      viewer_reaction.reaction AS viewer_reaction,
      (viewer_save.repo_id IS NOT NULL) AS viewer_saved,
      COALESCE((SELECT json_agg(selection.list_id ORDER BY selection.list_id) FROM (
        SELECT 'collection:' || viewer_list.collection_id::text AS list_id
        FROM app.collection_repos viewer_membership
        JOIN app.board_collections viewer_list USING(collection_id)
        WHERE viewer_membership.repo_id=r.repo_id AND viewer_list.user_id=${id}::uuid
        UNION ALL
        SELECT 'legacy-board:' || viewer_board.board_id::text AS list_id
        FROM app.board_repos viewer_membership JOIN app.boards viewer_board USING(board_id)
        WHERE viewer_membership.repo_id=r.repo_id AND viewer_board.user_id=${id}::uuid
      ) selection),'[]'::json) AS selected_list_ids
    FROM app.board_repos br
    JOIN app.repos r USING(repo_id)
    JOIN app.repo_content c USING(repo_id)
    JOIN app.repo_engagement e USING(repo_id)
    LEFT JOIN LATERAL (SELECT star_count,fork_count,open_issues_count,observed_at
      FROM app.repo_stat_snapshots snapshot WHERE snapshot.repo_id=r.repo_id
      ORDER BY observed_at DESC LIMIT 1) stat ON true
    LEFT JOIN LATERAL (SELECT card.summary_id,card.summary,to_jsonb(card)->'highlights' AS highlights,
      to_jsonb(card)->>'prompt_version' AS prompt_version,card.model_version,
      to_jsonb(card)->>'format_version' AS format_version,to_jsonb(card)->>'source' AS source
      FROM app.repo_card_summaries card WHERE card.repo_id=r.repo_id AND active
        AND card.content_version=c.content_version
        AND to_jsonb(card)->>'source' IN ('generated','description_fallback') ORDER BY created_at DESC LIMIT 1) summary ON true
    LEFT JOIN app.reactions viewer_reaction
      ON viewer_reaction.repo_id=r.repo_id AND viewer_reaction.user_id=${id}::uuid
    LEFT JOIN app.saves viewer_save
      ON viewer_save.repo_id=r.repo_id AND viewer_save.user_id=${id}::uuid
    WHERE br.board_id=${board}::uuid AND r.status='active'
    ORDER BY br.added_at DESC
  `;
  sendSuccess(res, 200, { items: rows });
}

export async function addBoardRepo(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const board = idParam(req, res, 'boardId'); const repo = idParam(req, res, 'repoId'); if (!id || !board || !repo) return;
  const event = req.body?.event;
  if (!isInteractionEventV2(event) || event.event_type !== 'save' || event.repo_id !== repo) {
    return sendError(res, 400, 'A stable v2 save event matching repoId is required.');
  }
  try {
    await addRepositoryToBoard(id, board, repo, event);
    res.status(204).end();
  } catch (error) { sendControllerError(res, error); }
}

export async function removeBoardRepo(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const board = idParam(req, res, 'boardId'); const repo = idParam(req, res, 'repoId'); if (!id || !board || !repo) return;
  try {
    const removed = await removeRepositoryFromBoard(id, board, repo);
    if (!removed) return sendError(res, 404, 'Board repository entry not found.');
    res.status(204).end();
  } catch (error) { sendControllerError(res, error); }
}
