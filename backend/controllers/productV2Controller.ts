import type { Response } from 'express';
import { sqlClient } from '../db/index.js';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import { processInteractionBatchV2InTransaction } from '../services/activityV2Service.js';
import { buildMlOnboardingJob, hasMlEmbeddingContext } from '../services/mlOnboardingService.js';
import { isInteractionEventV2 } from '../utils/interactionValidation.js';
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
  const target = idParam(req, res, 'userId'); if (!target) return;
  const rows = await sqlClient`
    SELECT u.user_id,u.username,u.full_name,u.bio,u.github_handle,u.avatar_url,u.created_at,
      s.followers_count,s.following_count,
      COALESCE((SELECT json_agg(t.slug ORDER BY t.slug) FROM app.user_topics ut JOIN app.topics t USING(topic_id)
        WHERE ut.user_id=u.user_id),'[]'::json) AS topics
    FROM app.users u JOIN app.user_stats s USING(user_id)
    WHERE u.user_id=${target}::uuid AND u.status='active'`;
  if (!rows[0]) return sendError(res, 404, 'User not found.');
  sendSuccess(res, 200, rows[0]);
}

export async function updateMe(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); if (!id) return;
  const allowed = ['username', 'full_name', 'bio', 'avatar_url'];
  if (!req.body || Object.keys(req.body).some((key) => !allowed.includes(key))) return sendError(res, 400, 'Unsupported profile field.');
  const usernameValue = req.body.username === undefined ? undefined : normalizeUsername(req.body.username) ?? undefined;
  const fullName = req.body.full_name === undefined ? undefined : text(req.body.full_name, 100);
  const bio = req.body.bio === undefined ? undefined : text(req.body.bio, 2_000);
  const avatarUrl = req.body.avatar_url === undefined ? undefined : text(req.body.avatar_url, 2_048);
  if ([usernameValue, fullName, bio, avatarUrl]
    .some((v, i) => Object.hasOwn(req.body, allowed[i]) && v === undefined)) {
    return sendError(res, 400, 'Invalid profile value.');
  }
  try {
    const updated = await sqlClient.begin(async (tx) => {
      const rows = await tx`
        UPDATE app.users SET username=COALESCE(${usernameValue ?? null},username),
          full_name=CASE WHEN ${req.body.full_name !== undefined} THEN ${fullName ?? null} ELSE full_name END,
          bio=CASE WHEN ${req.body.bio !== undefined} THEN ${bio ?? null} ELSE bio END,
          avatar_url=CASE WHEN ${req.body.avatar_url !== undefined} THEN ${avatarUrl ?? null} ELSE avatar_url END,
          profile_version=profile_version+1,updated_at=now()
        WHERE user_id=${id}::uuid
        RETURNING user_id,username,full_name,bio,github_handle,avatar_url,interests,skills,tech_stack,
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
    await sqlClient.begin(async (tx) => {
      const rows = await tx`INSERT INTO app.follows(follower_id,following_id) VALUES(${id}::uuid,${target}::uuid)
        ON CONFLICT DO NOTHING RETURNING follower_id`;
      if (rows.length) {
        await tx`UPDATE app.user_stats SET following_count=following_count+1,updated_at=now() WHERE user_id=${id}::uuid`;
        await tx`UPDATE app.user_stats SET followers_count=followers_count+1,updated_at=now() WHERE user_id=${target}::uuid`;
        await tx`
          INSERT INTO app.user_feed_state (user_id,feed_version,updated_at)
          VALUES (${id}::uuid,2,now())
          ON CONFLICT (user_id) DO UPDATE SET
            feed_version=app.user_feed_state.feed_version+1,
            updated_at=now()
        `;
      }
    });
    res.status(204).end();
  } catch (error) { sendControllerError(res, error); }
}

export async function removeFollow(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const target = idParam(req, res, 'userId'); if (!id || !target) return;
  await sqlClient.begin(async (tx) => {
    const rows = await tx`DELETE FROM app.follows WHERE follower_id=${id}::uuid AND following_id=${target}::uuid RETURNING follower_id`;
    if (rows.length) {
      await tx`UPDATE app.user_stats SET following_count=GREATEST(0,following_count-1),updated_at=now() WHERE user_id=${id}::uuid`;
      await tx`UPDATE app.user_stats SET followers_count=GREATEST(0,followers_count-1),updated_at=now() WHERE user_id=${target}::uuid`;
      await tx`
        INSERT INTO app.user_feed_state (user_id,feed_version,updated_at)
        VALUES (${id}::uuid,2,now())
        ON CONFLICT (user_id) DO UPDATE SET
          feed_version=app.user_feed_state.feed_version+1,
          updated_at=now()
      `;
    }
  });
  res.status(204).end();
}

async function followList(req: AuthRequest, res: Response, direction: 'followers' | 'following'): Promise<void> {
  const target = idParam(req, res, 'userId'); const page = paging(req); if (!target) return;
  if (!page) return sendError(res, 400, 'limit must be 1-100 and offset must be 0-10000.');
  const rows = direction === 'followers'
    ? await sqlClient`SELECT u.user_id,u.username,u.full_name,u.avatar_url,f.created_at FROM app.follows f JOIN app.users u ON u.user_id=f.follower_id WHERE f.following_id=${target}::uuid AND u.status='active' ORDER BY f.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`
    : await sqlClient`SELECT u.user_id,u.username,u.full_name,u.avatar_url,f.created_at FROM app.follows f JOIN app.users u ON u.user_id=f.following_id WHERE f.follower_id=${target}::uuid AND u.status='active' ORDER BY f.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`;
  sendSuccess(res, 200, { items: rows, ...page });
}
export const listFollowers = (req: AuthRequest, res: Response) => followList(req, res, 'followers');
export const listFollowing = (req: AuthRequest, res: Response) => followList(req, res, 'following');

export async function listLikesGiven(req: AuthRequest, res: Response): Promise<void> {
  const target = idParam(req, res, 'userId'); const page = paging(req); if (!target) return;
  if (!page) return sendError(res, 400, 'limit must be 1-100 and offset must be 0-10000.');
  const rows = await sqlClient`
    SELECT r.repo_id,r.url AS github_repo_url,r.owner AS owner_id,r.name AS repo_name,r.full_name,
      c.description,c.languages AS language_used,
      COALESCE((SELECT json_agg(t.slug ORDER BY t.slug) FROM app.repo_topics rt JOIN app.topics t USING(topic_id)
        WHERE rt.repo_id=r.repo_id),'[]'::json) AS topics,
      e.likes_count,COALESCE(s.star_count,0) AS star_count,COALESCE(s.fork_count,0) AS forks_count
    FROM app.reactions reaction JOIN app.repos r USING(repo_id)
    JOIN app.repo_content c USING(repo_id) JOIN app.repo_engagement e USING(repo_id)
    LEFT JOIN LATERAL (SELECT star_count,fork_count FROM app.repo_stat_snapshots snapshot
      WHERE snapshot.repo_id=r.repo_id ORDER BY observed_at DESC LIMIT 1) s ON true
    WHERE reaction.user_id=${target}::uuid AND reaction.reaction='like' AND r.status='active'
    ORDER BY reaction.updated_at DESC LIMIT ${page.limit} OFFSET ${page.offset}
  `;
  sendSuccess(res, 200, { items: rows, ...page });
}

const repoProjection = `r.repo_id,r.github_id,r.full_name,r.owner,r.name,r.url,c.description,c.primary_language,c.languages,c.content_version,
  e.likes_count,e.dislikes_count,e.saves_count,e.comments_count,e.views_count,
  s.star_count,s.fork_count,s.open_issues_count,s.observed_at,cs.summary,cs.model_version`;

export async function listRepositories(req: AuthRequest, res: Response): Promise<void> {
  const page = paging(req); if (!page) return sendError(res, 400, 'Invalid pagination.');
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const rows = await sqlClient.unsafe(`SELECT ${repoProjection} FROM app.repos r
    JOIN app.repo_content c USING(repo_id) JOIN app.repo_engagement e USING(repo_id)
    LEFT JOIN LATERAL (SELECT * FROM app.repo_stat_snapshots x WHERE x.repo_id=r.repo_id ORDER BY observed_at DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT summary,model_version FROM app.repo_card_summaries x WHERE x.repo_id=r.repo_id AND active ORDER BY created_at DESC LIMIT 1) cs ON true
    WHERE r.status='active' AND ($1='' OR r.full_name ILIKE '%'||$1||'%' OR COALESCE(c.description,'') ILIKE '%'||$1||'%')
    ORDER BY r.updated_at DESC,r.repo_id LIMIT $2 OFFSET $3`, [q, page.limit, page.offset]);
  sendSuccess(res, 200, { items: rows, ...page });
}

export async function getRepository(req: AuthRequest, res: Response): Promise<void> {
  const repo = idParam(req, res, 'repoId'); if (!repo) return;
  const rows = await sqlClient.unsafe(`SELECT ${repoProjection},c.readme,
    COALESCE((SELECT json_agg(t.slug ORDER BY t.slug) FROM app.repo_topics rt JOIN app.topics t USING(topic_id) WHERE rt.repo_id=r.repo_id),'[]'::json) topics
    FROM app.repos r JOIN app.repo_content c USING(repo_id) JOIN app.repo_engagement e USING(repo_id)
    LEFT JOIN LATERAL (SELECT * FROM app.repo_stat_snapshots x WHERE x.repo_id=r.repo_id ORDER BY observed_at DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT summary,model_version FROM app.repo_card_summaries x WHERE x.repo_id=r.repo_id AND active ORDER BY created_at DESC LIMIT 1) cs ON true
    WHERE r.repo_id=$1::uuid AND r.status='active'`, [repo]);
  if (!rows[0]) return sendError(res, 404, 'Repository not found.');
  sendSuccess(res, 200, rows[0]);
}

export async function listTrending(req: AuthRequest, res: Response): Promise<void> {
  const period = typeof req.query.period === 'string' ? req.query.period : 'daily';
  const rows = await sqlClient`SELECT i.position,i.score,i.features,r.repo_id,r.github_id,r.full_name,r.owner,r.name,r.url,
    c.description,c.primary_language,c.languages,e.likes_count,e.comments_count,e.views_count,
    COALESCE(stat.star_count,0) AS star_count,COALESCE(stat.fork_count,0) AS fork_count,
    COALESCE(stat.open_issues_count,0) AS open_issues_count,summary.summary
    FROM app.trending_snapshots s JOIN app.trending_snapshot_items i USING(snapshot_id)
    JOIN app.repos r USING(repo_id) JOIN app.repo_content c USING(repo_id) JOIN app.repo_engagement e USING(repo_id)
    LEFT JOIN LATERAL (SELECT star_count,fork_count,open_issues_count FROM app.repo_stat_snapshots x
      WHERE x.repo_id=r.repo_id ORDER BY observed_at DESC LIMIT 1) stat ON true
    LEFT JOIN LATERAL (SELECT summary FROM app.repo_card_summaries x
      WHERE x.repo_id=r.repo_id AND active ORDER BY created_at DESC LIMIT 1) summary ON true
    WHERE s.active AND s.complete AND s.period=${period} ORDER BY i.position LIMIT 100`;
  sendSuccess(res, 200, { period, items: rows });
}

export async function listSaved(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const page = paging(req); if (!id) return;
  if (!page) return sendError(res, 400, 'Invalid pagination.');
  const rows = await sqlClient`SELECT s.created_at,r.repo_id,r.github_id,r.full_name,r.owner,r.name,r.url,
    c.description,c.primary_language,c.languages,e.likes_count,e.comments_count,e.views_count,
    COALESCE(stat.star_count,0) AS star_count,COALESCE(stat.fork_count,0) AS fork_count,
    COALESCE(stat.open_issues_count,0) AS open_issues_count
    FROM app.saves s JOIN app.repos r USING(repo_id) JOIN app.repo_content c USING(repo_id)
    JOIN app.repo_engagement e USING(repo_id)
    LEFT JOIN LATERAL (SELECT star_count,fork_count,open_issues_count FROM app.repo_stat_snapshots x
      WHERE x.repo_id=r.repo_id ORDER BY observed_at DESC LIMIT 1) stat ON true
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
  const rows = resource === 'collection'
    ? await sqlClient`SELECT c.*,count(b.board_id)::int AS board_count FROM app.board_collections c LEFT JOIN app.boards b USING(collection_id) WHERE c.user_id=${id}::uuid GROUP BY c.collection_id ORDER BY c.created_at DESC`
    : await sqlClient`SELECT b.*,count(br.repo_id)::int AS repo_count FROM app.boards b LEFT JOIN app.board_repos br USING(board_id) WHERE b.user_id=${id}::uuid GROUP BY b.board_id ORDER BY b.created_at DESC`;
  sendSuccess(res, 200, { items: rows });
}
export const listCollections = (req: AuthRequest, res: Response) => listOwned(req, res, 'collection');
export const listBoards = (req: AuthRequest, res: Response) => listOwned(req, res, 'board');

export async function createCollection(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); if (!id) return; const name = text(req.body?.name, 100, true); const description = text(req.body?.description ?? null, 1_000);
  if (name === undefined || description === undefined) return sendError(res, 400, 'Invalid collection.');
  const rows = await sqlClient`INSERT INTO app.board_collections(user_id,name,description) VALUES(${id}::uuid,${name},${description}) RETURNING *`;
  sendSuccess(res, 201, rows[0]);
}

export async function updateCollection(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const collection = idParam(req, res, 'collectionId'); if (!id || !collection) return;
  const name = text(req.body?.name, 100, true); const description = text(req.body?.description ?? null, 1_000);
  if (name === undefined || description === undefined) return sendError(res, 400, 'Invalid collection.');
  const rows = await sqlClient`UPDATE app.board_collections SET name=${name},description=${description} WHERE collection_id=${collection}::uuid AND user_id=${id}::uuid RETURNING *`;
  if (!rows[0]) return sendError(res, 404, 'Collection not found.'); sendSuccess(res, 200, rows[0]);
}

export async function deleteCollection(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const collection = idParam(req, res, 'collectionId'); if (!id || !collection) return;
  const rows = await sqlClient`DELETE FROM app.board_collections WHERE collection_id=${collection}::uuid AND user_id=${id}::uuid RETURNING collection_id`;
  if (!rows[0]) return sendError(res, 404, 'Collection not found.'); res.status(204).end();
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
  const rows = await sqlClient`DELETE FROM app.boards WHERE board_id=${board}::uuid AND user_id=${id}::uuid RETURNING board_id`;
  if (!rows[0]) return sendError(res, 404, 'Board not found.'); res.status(204).end();
}

export async function listBoardRepos(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const board = idParam(req, res, 'boardId'); if (!id || !board) return;
  const allowed = await sqlClient`SELECT 1 FROM app.boards WHERE board_id=${board}::uuid AND (user_id=${id}::uuid OR visibility IN ('public','unlisted'))`;
  if (!allowed.length) return sendError(res, 404, 'Board not found.');
  const rows = await sqlClient`SELECT br.added_at,r.repo_id,r.full_name,r.owner,r.name,r.url,c.description,c.primary_language FROM app.board_repos br JOIN app.repos r USING(repo_id) JOIN app.repo_content c USING(repo_id) WHERE br.board_id=${board}::uuid ORDER BY br.added_at DESC`;
  sendSuccess(res, 200, { items: rows });
}

export async function addBoardRepo(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const board = idParam(req, res, 'boardId'); const repo = idParam(req, res, 'repoId'); if (!id || !board || !repo) return;
  const event = req.body?.event;
  if (!isInteractionEventV2(event) || event.event_type !== 'save' || event.repo_id !== repo) {
    return sendError(res, 400, 'A stable v2 save event matching repoId is required.');
  }
  try {
    await sqlClient.begin(async (tx) => {
      const owned = await tx`SELECT 1 FROM app.boards WHERE board_id=${board}::uuid AND user_id=${id}::uuid`;
      if (!owned.length) throw Object.assign(new Error('Board not found.'), { statusCode: 404 });
      await processInteractionBatchV2InTransaction(tx, id, [event]);
      await tx`
        INSERT INTO app.board_repos(board_id,repo_id,added_by)
        VALUES (${board}::uuid,${repo}::uuid,${id}::uuid)
        ON CONFLICT (board_id,repo_id) DO NOTHING
      `;
    });
    res.status(204).end();
  } catch (error) { sendControllerError(res, error); }
}

export async function removeBoardRepo(req: AuthRequest, res: Response): Promise<void> {
  const id = userId(req, res); const board = idParam(req, res, 'boardId'); const repo = idParam(req, res, 'repoId'); if (!id || !board || !repo) return;
  const rows = await sqlClient`DELETE FROM app.board_repos br USING app.boards b WHERE br.board_id=b.board_id AND br.board_id=${board}::uuid AND br.repo_id=${repo}::uuid AND b.user_id=${id}::uuid RETURNING br.board_id`;
  if (!rows.length) return sendError(res, 404, 'Board repository entry not found.'); res.status(204).end();
}
