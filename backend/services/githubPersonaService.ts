import { enqueueProfileDelivery } from './modelOperationService.js';
import type postgres from 'postgres';

import { sqlClient } from '../db/index.js';
import type { MlOnboardingJob } from '../contracts/ml.v2.js';
import type {
  GitHubInferredPersona,
  GitHubPersonaSkillId,
  GitHubPublicPersonaSource,
} from '../types/github.js';
import { inferGitHubPersona, normalizeGitHubPersonaSlug } from './githubPersonaInference.js';
export { inferGitHubPersona, normalizeGitHubPersonaSlug } from './githubPersonaInference.js';
import { fetchGitHubPublicPersona } from './githubService.js';
import { buildMlOnboardingJob, hasMlEmbeddingContext } from './mlOnboardingService.js';
import { claimVerifiedGithubProfile } from './socialProfileService.js';

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface StoredGitHubPersonaProfile {
  username: string;
  fullName: string | null;
  bio: string | null;
  githubId: string | null;
  githubHandle: string | null;
  avatarUrl: string | null;
  interests: string[];
  skills: string[];
  techStack: string[];
  onboardingCompleted: boolean;
  profileVersion: bigint;
}

export interface GitHubPersonaProfileUpdate {
  fullName: string | null;
  bio: string | null;
  githubId: string;
  githubHandle: string;
  avatarUrl: string | null;
  interests: string[];
  skills: string[];
  techStack: string[];
}

export interface GitHubPersonaUpdatePlan {
  update: GitHubPersonaProfileUpdate;
  materialChange: boolean;
  nextProfileVersion: bigint;
  topicSlugsToInsert: string[];
}

function storedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    : [];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeGitHubPersonaSlug).filter(Boolean))].sort();
}

export function planGitHubPersonaUpdate(
  existing: StoredGitHubPersonaProfile,
  existingTopicSlugs: readonly string[],
  source: GitHubPublicPersonaSource,
  inferred: GitHubInferredPersona,
): GitHubPersonaUpdatePlan {
  const currentInterests = storedStrings(existing.interests);
  const currentSkills = storedStrings(existing.skills);
  const currentTechStack = storedStrings(existing.techStack);
  const update: GitHubPersonaProfileUpdate = {
    fullName: nonBlank(source.profile.name) ?? existing.fullName,
    bio: nonBlank(source.profile.bio) ?? existing.bio,
    githubId: String(source.profile.id),
    githubHandle: source.profile.login,
    avatarUrl: nonBlank(source.profile.avatar_url) ?? existing.avatarUrl,
    interests: currentInterests.length > 0 ? currentInterests : inferred.interests,
    skills: currentSkills.length > 0 ? currentSkills : inferred.skills,
    techStack: currentTechStack.length > 0 ? currentTechStack : inferred.tech_stack,
  };
  const topicSlugsToInsert = existingTopicSlugs.length > 0
    ? []
    : uniqueNormalized([...update.interests, ...update.skills, ...update.techStack]);
  const materialChange = update.fullName !== existing.fullName
    || update.bio !== existing.bio
    || update.githubId !== existing.githubId
    || update.githubHandle !== existing.githubHandle
    || update.avatarUrl !== existing.avatarUrl
    || !sameStrings(update.interests, currentInterests)
    || !sameStrings(update.skills, currentSkills)
    || !sameStrings(update.techStack, currentTechStack)
    || topicSlugsToInsert.length > 0;
  return {
    update,
    materialChange,
    nextProfileVersion: existing.profileVersion + (materialChange ? 1n : 0n),
    topicSlugsToInsert,
  };
}

export interface GitHubPersonaTransactionStore {
  lockProfile(userId: string): Promise<StoredGitHubPersonaProfile | null>;
  listTopicSlugs(userId: string): Promise<string[]>;
  updateProfile(userId: string, update: GitHubPersonaProfileUpdate): Promise<bigint>;
  ensureUserTopic(userId: string, slug: string): Promise<boolean>;
  enqueueOnboarding(userId: string, profileVersion: bigint, job: MlOnboardingJob): Promise<boolean>;
}

class PostgresGitHubPersonaTransactionStore implements GitHubPersonaTransactionStore {
  constructor(private readonly tx: postgres.TransactionSql) {}

  async lockProfile(userId: string): Promise<StoredGitHubPersonaProfile | null> {
    const rows = await this.tx`
      SELECT username,full_name,bio,github_id,github_handle,avatar_url,
        interests,skills,tech_stack,onboarding_completed,profile_version
      FROM app.users WHERE user_id=${userId}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      username: String(row.username),
      fullName: row.full_name == null ? null : String(row.full_name),
      bio: row.bio == null ? null : String(row.bio),
      githubId: row.github_id == null ? null : String(row.github_id),
      githubHandle: row.github_handle == null ? null : String(row.github_handle),
      avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
      interests: storedStrings(row.interests),
      skills: storedStrings(row.skills),
      techStack: storedStrings(row.tech_stack),
      onboardingCompleted: row.onboarding_completed === true,
      profileVersion: BigInt(String(row.profile_version)),
    };
  }

  async listTopicSlugs(userId: string): Promise<string[]> {
    const rows = await this.tx`
      SELECT topic.slug FROM app.user_topics user_topic
      JOIN app.topics topic USING(topic_id)
      WHERE user_topic.user_id=${userId}::uuid ORDER BY topic.slug
    `;
    return rows.map((row) => String(row.slug));
  }

  async updateProfile(userId: string, update: GitHubPersonaProfileUpdate): Promise<bigint> {
    const rows = await this.tx`
      UPDATE app.users SET
        full_name=${update.fullName},bio=${update.bio},github_id=${update.githubId},
        github_handle=${update.githubHandle},github_identity_verified_at=now(),avatar_url=${update.avatarUrl},
        interests=${JSON.stringify(update.interests)}::jsonb,
        skills=${JSON.stringify(update.skills)}::jsonb,
        tech_stack=${JSON.stringify(update.techStack)}::jsonb,
        profile_version=profile_version+1,updated_at=now()
      WHERE user_id=${userId}::uuid RETURNING profile_version
    `;
    if (!rows[0]) throw Object.assign(new Error('User profile not found.'), { statusCode: 404 });
    await claimVerifiedGithubProfile(this.tx, {
      userId,
      githubId: update.githubId,
      githubHandle: update.githubHandle,
      displayName: update.fullName,
      avatarUrl: update.avatarUrl,
    });
    // Only material persona changes call updateProfile; repair retries retain
    // their namespace. Follow existing user/social-profile locks before feed.
    await this.tx`
      INSERT INTO app.user_feed_state(user_id,feed_version) VALUES(${userId}::uuid,2)
      ON CONFLICT(user_id) DO UPDATE SET feed_version=app.user_feed_state.feed_version+1,updated_at=now()
    `;
    return BigInt(String(rows[0].profile_version));
  }

  async ensureUserTopic(userId: string, slug: string): Promise<boolean> {
    const topics = await this.tx`
      INSERT INTO app.topics(slug,display_name) VALUES (${slug},${slug})
      ON CONFLICT(slug) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING topic_id
    `;
    const rows = await this.tx`
      INSERT INTO app.user_topics(user_id,topic_id) VALUES (${userId}::uuid,${topics[0].topic_id})
      ON CONFLICT(user_id,topic_id) DO NOTHING RETURNING topic_id
    `;
    return rows.length > 0;
  }

  async enqueueOnboarding(
    userId: string,
    profileVersion: bigint,
    job: MlOnboardingJob,
  ): Promise<boolean> {
    return enqueueProfileDelivery(this.tx,job);
  }
}

export interface GitHubPersonaSyncResult {
  changed: boolean;
  enqueued: boolean;
  profileVersion: string;
  topicsAdded: number;
  persona: GitHubInferredPersona;
}

function profileVersionNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Profile version exceeds the supported ML contract range.');
  }
  return Number(value);
}

export async function persistGitHubPersona(
  store: GitHubPersonaTransactionStore,
  userId: string,
  source: GitHubPublicPersonaSource,
  inferred = inferGitHubPersona(source),
): Promise<GitHubPersonaSyncResult> {
  const existing = await store.lockProfile(userId);
  if (!existing) throw Object.assign(new Error('User profile not found.'), { statusCode: 404 });
  const existingTopicSlugs = await store.listTopicSlugs(userId);
  const plan = planGitHubPersonaUpdate(existing, existingTopicSlugs, source, inferred);
  const profileVersion = plan.materialChange
    ? await store.updateProfile(userId, plan.update)
    : existing.profileVersion;

  let topicsAdded = 0;
  for (const slug of plan.topicSlugsToInsert) {
    if (await store.ensureUserTopic(userId, slug)) topicsAdded += 1;
  }

  const semanticInterests = [...new Set([...existingTopicSlugs, ...plan.update.interests])];
  const job = buildMlOnboardingJob(userId, profileVersionNumber(profileVersion), {
    username: existing.username,
    fullName: plan.update.fullName,
    bio: plan.update.bio,
    githubUsername: plan.update.githubHandle,
    avatarUrl: plan.update.avatarUrl,
    interests: semanticInterests,
    skills: plan.update.skills,
    techStack: plan.update.techStack,
  });
  const enqueued = hasMlEmbeddingContext(job.profile)
    ? await store.enqueueOnboarding(userId, profileVersion, job)
    : false;

  return {
    changed: plan.materialChange,
    enqueued,
    profileVersion: String(profileVersion),
    topicsAdded,
    persona: {
      interests: plan.update.interests,
      skills: plan.update.skills as GitHubPersonaSkillId[],
      tech_stack: plan.update.techStack,
    },
  };
}

export async function syncGitHubPersona(
  userId: string,
  githubHandle: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GitHubPersonaSyncResult> {
  const source = await fetchGitHubPublicPersona(githubHandle, options);
  const inferred = inferGitHubPersona(source);
  return sqlClient.begin((tx) => persistGitHubPersona(
    new PostgresGitHubPersonaTransactionStore(tx),
    userId,
    source,
    inferred,
  ));
}
