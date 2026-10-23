import { sqlClient } from '../db/index.js';
import { buildMlOnboardingJob, hasMlEmbeddingContext } from './mlOnboardingService.js';
import { claimVerifiedGithubProfile } from './socialProfileService.js';
import { githubIdentityFenceMatches, type GithubIdentityFence } from './githubIdentityFence.js';

interface IdentityProfile {
  userId: string;
  username: string;
  fullName?: string | null;
  dateOfBirth?: string | null;
  bio?: string | null;
  githubId?: string | null;
  githubHandle?: string | null;
  githubIdentityVerified?: boolean;
  githubIdentityFence?: GithubIdentityFence | null;
  avatarUrl?: string | null;
  onboardingCompleted?: boolean;
}

interface AuthIdentity {
  id?: string;
  provider?: string;
  identity_data?: Record<string, unknown>;
}

export function githubIdentityFromAuthUser(user: {
  identities?: AuthIdentity[] | null;
  user_metadata?: Record<string, unknown>;
}, authenticatedProvider?: 'github' | 'google'): { githubId: string | null; githubHandle: string | null } {
  const identity = user.identities?.find((candidate) => candidate.provider === 'github');
  // Supabase normally returns linked identities, but a freshly-created OAuth
  // user can arrive with only provider metadata. The attempted provider comes
  // from our server-side OAuth state, so it is safe to use that metadata only
  // for a GitHub attempt and never mistake Google's numeric subject for GitHub.
  const identityData = identity?.identity_data
    ?? (authenticatedProvider === 'github' ? user.user_metadata : undefined);
  const rawId = identityData?.provider_id ?? identityData?.sub ?? identity?.id;
  const githubId = (typeof rawId === 'string' || typeof rawId === 'number')
    && /^\d{1,30}$/.test(String(rawId).trim())
    ? String(rawId).trim()
    : null;
  const rawHandle = [identityData?.preferred_username, identityData?.user_name]
    .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  const githubHandle = rawHandle && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(rawHandle.trim())
    ? rawHandle.trim()
    : null;
  return { githubId, githubHandle };
}

export function isVerifiedGitHubIdentity(
  githubId: string | null | undefined,
  githubHandle: string | null | undefined,
): boolean {
  return typeof githubId === 'string'
    && /^\d{1,30}$/.test(githubId.trim())
    && typeof githubHandle === 'string'
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(githubHandle.trim());
}

export async function githubIdentityForProvisioning(
  user: { id: string; identities?: AuthIdentity[] | null; user_metadata?: Record<string, unknown> },
  refresh: () => Promise<{ id: string; identities?: AuthIdentity[] | null; user_metadata?: Record<string, unknown> }>,
  authenticatedProvider?: 'github' | 'google',
) {
  const [operation] = await sqlClient`SELECT operation_id,status FROM app.user_github_unlinks WHERE user_id=${user.id}::uuid`;
  const fence: GithubIdentityFence | null = operation
    ? { operationId: String(operation.operation_id), status: String(operation.status) } : null;
  if (!fence) return { ...githubIdentityFromAuthUser(user, authenticatedProvider), fence };
  // Network reads stay outside SQL locks. Metadata can survive an unlink, so a
  // refreshed observation must have an actual linked GitHub identity.
  const fresh = await refresh();
  if (fresh.id !== user.id || !Array.isArray(fresh.identities)) {
    throw Object.assign(new Error('Provider identity could not be verified.'), { statusCode: 503 });
  }
  return { ...githubIdentityFromAuthUser(fresh), fence };
}

export async function ensureIdentityProfile(profile: IdentityProfile): Promise<void> {
  const githubIdentityVerified = profile.githubIdentityVerified === true
    && isVerifiedGitHubIdentity(profile.githubId, profile.githubHandle);
  await sqlClient.begin(async (tx) => {
    await tx`
      INSERT INTO app.users (
        user_id,username,full_name,date_of_birth,bio,github_id,github_handle,
        github_identity_verified_at,avatar_url,onboarding_completed
      )
      VALUES (${profile.userId}::uuid,${profile.username},${profile.fullName ?? null},${profile.dateOfBirth ?? null},
        ${profile.bio ?? null},NULL,NULL,
        NULL,${profile.avatarUrl ?? null},
        ${profile.onboardingCompleted === true})
      ON CONFLICT (user_id) DO UPDATE SET
        full_name=COALESCE(EXCLUDED.full_name,app.users.full_name),
        date_of_birth=COALESCE(EXCLUDED.date_of_birth,app.users.date_of_birth),
        bio=COALESCE(EXCLUDED.bio,app.users.bio),
        avatar_url=COALESCE(EXCLUDED.avatar_url,app.users.avatar_url),
        -- Identity provisioning may insert the initial state, but it must not
        -- mutate a durable onboarding decision on conflict. Only onboarding or
        -- the GitHub persona sync is allowed to complete an existing profile.
        onboarding_completed=app.users.onboarding_completed,
        updated_at=now()
    `;
    // The upsert acquired the user lock; unlink preparation/completion uses the
    // same lock first. Re-read after acquiring it, never reuse a pre-lock row.
    const [operation] = await tx`SELECT operation_id,status FROM app.user_github_unlinks WHERE user_id=${profile.userId}::uuid FOR UPDATE`;
    const currentFence: GithubIdentityFence | null = operation
      ? { operationId: String(operation.operation_id), status: String(operation.status) } : null;
    const acceptGithub = githubIdentityVerified
      && githubIdentityFenceMatches(profile.githubIdentityFence, currentFence);
    if (acceptGithub) {
      await tx`UPDATE app.users SET github_id=${profile.githubId!},github_handle=${profile.githubHandle!},
        github_identity_verified_at=now(),updated_at=now() WHERE user_id=${profile.userId}::uuid`;
      if (currentFence) await tx`UPDATE app.user_github_unlinks SET status='superseded',updated_at=now()
        WHERE user_id=${profile.userId}::uuid AND operation_id=${currentFence.operationId}::uuid`;
    }
    const onboardingJob = buildMlOnboardingJob(profile.userId, 1, {
      username: profile.username, fullName: profile.fullName, bio: profile.bio,
      githubUsername: acceptGithub ? profile.githubHandle : null, avatarUrl: profile.avatarUrl,
    });
    await tx`INSERT INTO app.user_stats (user_id) VALUES (${profile.userId}::uuid) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO app.user_feed_state (user_id) VALUES (${profile.userId}::uuid) ON CONFLICT DO NOTHING`;
    if (acceptGithub && profile.githubId && profile.githubHandle) {
      await claimVerifiedGithubProfile(tx, {
        userId: profile.userId,
        githubId: profile.githubId,
        githubHandle: profile.githubHandle,
        displayName: profile.fullName,
        avatarUrl: profile.avatarUrl,
      });
    }
    if (hasMlEmbeddingContext(onboardingJob.profile)) {
      await tx`
        INSERT INTO telemetry.ml_outbox (job_type,aggregate_id,idempotency_key,payload)
        VALUES ('onboard',${profile.userId}::uuid,${`onboard:${profile.userId}:1`},${JSON.stringify(onboardingJob)}::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
    }
  });
}

export function fallbackUsername(userId: string, metadata: Record<string, unknown> | undefined): string {
  const raw = [metadata?.user_name, metadata?.preferred_username, metadata?.name]
    .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  const base = (raw ?? 'user').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 38) || 'user';
  return `${base}-${userId.slice(0, 8)}`;
}
