import { sqlClient } from '../db/index.js';
import { buildMlOnboardingJob, hasMlEmbeddingContext } from './mlOnboardingService.js';
import { claimVerifiedGithubProfile } from './socialProfileService.js';

interface IdentityProfile {
  userId: string;
  username: string;
  fullName?: string | null;
  dateOfBirth?: string | null;
  bio?: string | null;
  githubId?: string | null;
  githubHandle?: string | null;
  githubIdentityVerified?: boolean;
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

export async function ensureIdentityProfile(profile: IdentityProfile): Promise<void> {
  const githubIdentityVerified = profile.githubIdentityVerified === true
    && isVerifiedGitHubIdentity(profile.githubId, profile.githubHandle);
  const onboardingJob = buildMlOnboardingJob(profile.userId, 1, {
    username: profile.username,
    fullName: profile.fullName,
    bio: profile.bio,
    githubUsername: profile.githubHandle,
    avatarUrl: profile.avatarUrl,
  });
  await sqlClient.begin(async (tx) => {
    await tx`
      INSERT INTO app.users (
        user_id,username,full_name,date_of_birth,bio,github_id,github_handle,
        github_identity_verified_at,avatar_url,onboarding_completed
      )
      VALUES (${profile.userId}::uuid,${profile.username},${profile.fullName ?? null},${profile.dateOfBirth ?? null},
        ${profile.bio ?? null},${profile.githubId ?? null},${profile.githubHandle ?? null},
        CASE WHEN ${githubIdentityVerified} THEN now() ELSE NULL END,${profile.avatarUrl ?? null},
        ${profile.onboardingCompleted === true})
      ON CONFLICT (user_id) DO UPDATE SET
        full_name=COALESCE(EXCLUDED.full_name,app.users.full_name),
        date_of_birth=COALESCE(EXCLUDED.date_of_birth,app.users.date_of_birth),
        bio=COALESCE(EXCLUDED.bio,app.users.bio),
        github_id=COALESCE(EXCLUDED.github_id,app.users.github_id),
        github_handle=COALESCE(EXCLUDED.github_handle,app.users.github_handle),
        github_identity_verified_at=COALESCE(
          EXCLUDED.github_identity_verified_at,
          app.users.github_identity_verified_at
        ),
        avatar_url=COALESCE(EXCLUDED.avatar_url,app.users.avatar_url),
        -- Identity provisioning may insert the initial state, but it must not
        -- mutate a durable onboarding decision on conflict. Only onboarding or
        -- the GitHub persona sync is allowed to complete an existing profile.
        onboarding_completed=app.users.onboarding_completed,
        updated_at=now()
    `;
    await tx`INSERT INTO app.user_stats (user_id) VALUES (${profile.userId}::uuid) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO app.user_feed_state (user_id) VALUES (${profile.userId}::uuid) ON CONFLICT DO NOTHING`;
    if (githubIdentityVerified && profile.githubId && profile.githubHandle) {
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
