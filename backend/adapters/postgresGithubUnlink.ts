import type { Sql } from 'postgres';
import { sqlClient } from '../db/index.js';
import type { GithubUnlinkOwner, GithubUnlinkPersistence } from '../services/githubUnlinkFlow.js';
import { buildMlOnboardingJob, hasMlEmbeddingContext } from '../services/mlOnboardingService.js';

const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
export class PostgresGithubUnlink implements GithubUnlinkPersistence {
  constructor(private readonly db: Sql = sqlClient) {}
  async owner(userId: string): Promise<GithubUnlinkOwner> {
    const [profile] = await this.db`SELECT user_id,github_id,github_identity_verified_at FROM app.users WHERE user_id=${userId}::uuid AND status='active'`;
    if (!profile?.github_identity_verified_at || !/^[1-9][0-9]{0,18}$/.test(String(profile.github_id))) throw fail('No verified GitHub login is linked to this account.');
    return { userId: String(profile.user_id), githubId: String(profile.github_id) };
  }
  async prepare(owner: GithubUnlinkOwner, operationId: string) {
    await this.db.begin(async tx => {
      const [profile] = await tx`SELECT github_id,github_identity_verified_at,status FROM app.users WHERE user_id=${owner.userId}::uuid FOR UPDATE`;
      if (profile?.status !== 'active' || !profile.github_identity_verified_at || String(profile.github_id) !== owner.githubId) throw fail('The verified GitHub account changed.');
      const [prepared] = await tx`INSERT INTO app.user_github_unlinks(user_id,operation_id,github_id,status)
        VALUES(${owner.userId}::uuid,${operationId}::uuid,${owner.githubId},'prepared')
        ON CONFLICT(user_id) DO UPDATE SET operation_id=EXCLUDED.operation_id,github_id=EXCLUDED.github_id,
          status='prepared',created_at=now(),updated_at=now()
        WHERE app.user_github_unlinks.status <> 'prepared' RETURNING operation_id`;
      if (!prepared) throw fail('A GitHub disconnect is already pending verification. Check its status before retrying.');
    });
  }
  async refused(owner: GithubUnlinkOwner, operationId: string) {
    await this.db`UPDATE app.user_github_unlinks SET status='refused',updated_at=now()
      WHERE user_id=${owner.userId}::uuid AND operation_id=${operationId}::uuid AND status='prepared'`;
  }
  async operation(userId: string) {
    const [operation] = await this.db`SELECT user_id,operation_id,github_id,status FROM app.user_github_unlinks WHERE user_id=${userId}::uuid`;
    return operation ? { userId: String(operation.user_id), githubId: String(operation.github_id),
      operationId: String(operation.operation_id), status: String(operation.status) } : null;
  }
  async complete(owner: GithubUnlinkOwner, operationId: string): Promise<'done' | 'superseded'> {
    return this.db.begin(async tx => {
      // Preserve the existing user -> GitHub-owner -> social-profile -> feed order.
      const [profile] = await tx`SELECT * FROM app.users WHERE user_id=${owner.userId}::uuid FOR UPDATE`;
      const [operation] = await tx`SELECT * FROM app.user_github_unlinks WHERE user_id=${owner.userId}::uuid AND operation_id=${operationId}::uuid FOR UPDATE`;
      if (!profile || !operation) throw fail('This unlink operation was superseded.');
      if (operation.status === 'done' || operation.status === 'superseded') return operation.status;
      if (operation.status !== 'prepared' || operation.github_id !== owner.githubId) throw fail('This unlink operation cannot be completed.');
      if (profile.github_id && String(profile.github_id) !== owner.githubId) {
        await tx`UPDATE app.user_github_unlinks SET status='superseded',updated_at=now() WHERE user_id=${owner.userId}::uuid`;
        return 'superseded';
      }
      if (profile.github_id) {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'github-owner:' + owner.githubId},0))`;
        await tx`SELECT profile_id FROM app.social_profiles WHERE provider='github'
          AND ltrim(provider_subject,'0')=${owner.githubId} ORDER BY profile_id FOR UPDATE`;
        await tx`UPDATE app.social_profiles SET claimed_by_user_id=NULL,updated_at=now()
          WHERE provider='github' AND ltrim(provider_subject,'0')=${owner.githubId} AND claimed_by_user_id=${owner.userId}::uuid`;
        const [updated] = await tx`UPDATE app.users SET github_id=NULL,github_handle=NULL,github_identity_verified_at=NULL,
          profile_version=profile_version+1,updated_at=now() WHERE user_id=${owner.userId}::uuid RETURNING *`;
        await tx`INSERT INTO app.user_feed_state(user_id,feed_version) VALUES(${owner.userId}::uuid,2)
          ON CONFLICT(user_id) DO UPDATE SET feed_version=app.user_feed_state.feed_version+1,updated_at=now()`;
        const version = Number(updated.profile_version);
        if (!Number.isSafeInteger(version)) throw fail('Profile version exceeds the supported contract.', 503);
        const job = buildMlOnboardingJob(owner.userId, version, { username: updated.username,
          fullName: updated.full_name, bio: updated.bio, githubUsername: null, avatarUrl: updated.avatar_url,
          interests: updated.interests, skills: updated.skills, techStack: updated.tech_stack });
        if (hasMlEmbeddingContext(job.profile)) await tx`INSERT INTO telemetry.ml_outbox(job_type,aggregate_id,idempotency_key,payload)
          VALUES('onboard',${owner.userId}::uuid,${`onboard:${owner.userId}:${version}`},${JSON.stringify(job)}::jsonb) ON CONFLICT DO NOTHING`;
        else await tx`UPDATE app.users SET onboarding_completed=false WHERE user_id=${owner.userId}::uuid`;
      }
      await tx`UPDATE app.user_github_unlinks SET status='done',updated_at=now() WHERE user_id=${owner.userId}::uuid AND operation_id=${operationId}::uuid`;
      return 'done';
    });
  }
}
