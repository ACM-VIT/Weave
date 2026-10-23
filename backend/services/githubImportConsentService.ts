import { withOutboxTrace } from '../observability/tracing.js';
import crypto from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { sqlClient } from '../db/index.js';
import { PostgresRepositoryPersistence } from '../adapters/postgresRepositoryPersistence.js';
import type { GitHubActivityImportClient, GitHubActivitySnapshot } from './githubActivityImport.js';
import { importedPreferences, mergeImportedPreferences } from './githubPreferenceProjection.js';
import { normalizeOnboardingTopic } from '../contracts/onboardingTaxonomy.js';
import { buildMlOnboardingJob, hasMlEmbeddingContext } from './mlOnboardingService.js';

export interface GitHubImportCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}
type Preferences = { interests: string[]; skills: string[]; tech_stack: string[] };
const fields = ['interests', 'skills', 'tech_stack'] as const;
const failure = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const key = (userId: string, snapshotId: string) => `persona:github-import:v1:${userId}:${snapshotId}`;
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const arrays = (value: Record<string, unknown>): Preferences => ({
  interests: Array.isArray(value.interests) ? value.interests.map(String) : [],
  skills: Array.isArray(value.skills) ? value.skills.map(String) : [],
  tech_stack: Array.isArray(value.tech_stack) ? value.tech_stack.map(String) : [],
});

export class GitHubImportConsentService {
  private collecting = 0;
  constructor(private readonly collector: Pick<GitHubActivityImportClient, 'collect'>,
    private readonly cache: GitHubImportCache, private readonly db: Sql = sqlClient) {}

  private async owner(tx: TransactionSql, userId: string) {
    const [profile] = await tx`SELECT * FROM app.users WHERE user_id=${userId}::uuid AND status='active' FOR UPDATE`;
    if (!profile) throw failure('User profile not found.', 404);
    // Read after acquiring the owner lock: an earlier statement snapshot could
    // miss an unlink intent committed while this query waited for that lock.
    const [intent] = await tx`SELECT status FROM app.user_github_unlinks WHERE user_id=${userId}::uuid AND status='prepared'`;
    profile.unlink_pending = Boolean(intent);
    return profile;
  }
  private verified(profile: Record<string, unknown>) {
    if (profile.unlink_pending) throw failure('GitHub disconnect needs verification before importing activity.');
    if (!profile.github_id || !profile.github_handle || !profile.github_identity_verified_at) {
      throw failure('A verified GitHub login identity is required for public activity import.');
    }
    return { githubId: String(profile.github_id), handle: String(profile.github_handle) };
  }
  private async state(tx: TransactionSql, userId: string) {
    await tx`INSERT INTO app.user_github_imports(user_id) VALUES(${userId}::uuid) ON CONFLICT DO NOTHING`;
    const [state] = await tx`SELECT * FROM app.user_github_imports WHERE user_id=${userId}::uuid FOR UPDATE`;
    return state;
  }
  private snapshot(userId: string, state: Record<string, unknown>): Promise<GitHubActivitySnapshot>;
  private snapshot(userId: string, state: Record<string, unknown>, allowMissing: true): Promise<GitHubActivitySnapshot | null>;
  private async snapshot(userId: string, state: Record<string, unknown>, allowMissing = false): Promise<GitHubActivitySnapshot | null> {
    const raw = await this.cache.get(key(userId, String(state.snapshot_id)));
    if (raw === null && allowMissing) return null;
    if (!raw || Buffer.byteLength(raw, 'utf8') > 8_388_608 || hash(raw) !== state.snapshot_hash) {
      throw failure('The import preview expired. Preview public activity again.');
    }
    return JSON.parse(raw) as GitHubActivitySnapshot;
  }
  private previewResult(snapshotId: string, snapshot: GitHubActivitySnapshot, expiresAt: Date) {
    return { snapshot_id: snapshotId, collected_at: snapshot.collected_at, status: snapshot.status,
      sources: snapshot.sources, repository_count: snapshot.repositories.length,
      suggestions: importedPreferences(snapshot), expires_at: expiresAt.toISOString(),
      expires_in_seconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000)) };
  }

  async status(userId: string) {
    return this.db.begin(async tx => {
      const profile = await this.owner(tx, userId);
      const [state] = await tx`SELECT accepted_at,revoked_at,consented_at,provenance FROM app.user_github_imports WHERE user_id=${userId}::uuid`;
      return { unlink_pending: Boolean(profile.unlink_pending), linked: Boolean(profile.github_id && profile.github_identity_verified_at),
        active: Boolean(state?.accepted_at && !state.revoked_at),
        consented_at: state?.consented_at ?? null, accepted_at: state?.accepted_at ?? null,
        provenance: state?.provenance ?? {}, profile_version: String(profile.profile_version) };
    });
  }

  async preview(userId: string, consent: unknown, signal?: AbortSignal) {
    if (consent !== true) throw failure('Explicit consent is required before collecting public GitHub activity.', 400);
    const token = crypto.randomUUID();
    const claim = await this.db.begin(async tx => {
      const profile = await this.owner(tx, userId);
      const identity = this.verified(profile);
      const state = await this.state(tx, userId);
      if (state.accepted_at && !state.revoked_at) throw failure('Revoke the current import before collecting new activity.');
      if (state.snapshot_id && state.github_id === identity.githubId && new Date(state.expires_at).getTime() > Date.now()) {
        return { identity, state, cached: true };
      }
      if (state.collect_until && new Date(state.collect_until).getTime() > Date.now()) throw failure('A public activity preview is already running.', 429);
      if (state.last_collected_at && Date.now() - new Date(state.last_collected_at).getTime() < 60_000) throw failure('Wait one minute before collecting public activity again.', 429);
      await tx`UPDATE app.user_github_imports SET collect_token=${token}::uuid,collect_until=now()+interval '10 seconds',
        last_collected_at=now(),consented_at=now(),revoked_at=NULL,github_id=${identity.githubId} WHERE user_id=${userId}::uuid`;
      return { identity, state, cached: false };
    });
    if (claim.cached) {
      try { return this.previewResult(String(claim.state.snapshot_id), await this.snapshot(userId, claim.state), new Date(claim.state.expires_at)); }
      catch (error) {
        await this.db`UPDATE app.user_github_imports SET expires_at=now() WHERE user_id=${userId}::uuid AND snapshot_id=${claim.state.snapshot_id}::uuid`;
        throw error;
      }
    }
    let admitted = false;
    try {
      if (this.collecting >= 4) throw failure('Public activity collection is busy. Try again shortly.', 503);
      this.collecting++; admitted = true;
      const snapshot = await this.collector.collect(claim.identity, signal);
      signal?.throwIfAborted();
      const raw = JSON.stringify(snapshot);
      if (Buffer.byteLength(raw, 'utf8') > 8_388_608) throw failure('The public activity preview is too large.', 413);
      await this.cache.set(key(userId, token), raw, 'EX', 300);
      const expiresAt = await this.db.begin(async tx => {
        const profile = await this.owner(tx, userId);
        const identity = this.verified(profile);
        const state = await this.state(tx, userId);
        if (identity.githubId !== claim.identity.githubId || state.collect_token !== token
          || String(state.revision) !== String(claim.state.revision)) throw failure('The import was revoked or the account changed.');
        const [saved] = await tx`UPDATE app.user_github_imports SET snapshot_id=${token}::uuid,snapshot_hash=${hash(raw)},expires_at=now()+interval '5 minutes'
          WHERE user_id=${userId}::uuid RETURNING expires_at`;
        return new Date(saved.expires_at);
      });
      return this.previewResult(token, snapshot, expiresAt);
    } catch (error) {
      await this.cache.del(key(userId, token)).catch(() => undefined);
      throw error;
    } finally {
      if (admitted) this.collecting--;
      await this.db`UPDATE app.user_github_imports SET collect_token=NULL,collect_until=NULL
        WHERE user_id=${userId}::uuid AND collect_token=${token}::uuid`;
    }
  }

  private async writeProfile(tx: TransactionSql, userId: string, preferences: Preferences, completed: boolean) {
    const [profile] = await tx`UPDATE app.users SET interests=${JSON.stringify(preferences.interests)}::jsonb,
      skills=${JSON.stringify(preferences.skills)}::jsonb,tech_stack=${JSON.stringify(preferences.tech_stack)}::jsonb,
      onboarding_completed=${completed},profile_version=profile_version+1,updated_at=now()
      WHERE user_id=${userId}::uuid RETURNING *`;
    await tx`INSERT INTO app.user_feed_state(user_id,feed_version) VALUES(${userId}::uuid,2)
      ON CONFLICT(user_id) DO UPDATE SET feed_version=app.user_feed_state.feed_version+1,updated_at=now()`;
    await tx`DELETE FROM app.user_topics WHERE user_id=${userId}::uuid`;
    for (const topic of new Set(fields.flatMap(field => preferences[field].map(normalizeOnboardingTopic)))) {
      const [record] = await tx`INSERT INTO app.topics(slug,display_name) VALUES(${topic},${topic})
        ON CONFLICT(slug) DO UPDATE SET display_name=app.topics.display_name RETURNING topic_id`;
      await tx`INSERT INTO app.user_topics(user_id,topic_id) VALUES(${userId}::uuid,${record.topic_id}) ON CONFLICT DO NOTHING`;
    }
    const version = Number(profile.profile_version);
    if (!Number.isSafeInteger(version)) throw failure('Profile version exceeds the supported contract.', 503);
    const job = buildMlOnboardingJob(userId, version, { username: profile.username, fullName: profile.full_name,
      bio: profile.bio, githubUsername: profile.github_handle, avatarUrl: profile.avatar_url,
      interests: preferences.interests, skills: preferences.skills, techStack: preferences.tech_stack });
    if (hasMlEmbeddingContext(job.profile)) await tx`INSERT INTO telemetry.ml_outbox(job_type,aggregate_id,idempotency_key,payload)
      VALUES('onboard',${userId}::uuid,${`onboard:${userId}:${version}`},${JSON.stringify(withOutboxTrace(job))}::jsonb) ON CONFLICT DO NOTHING`;
    return { profile_version: String(version), completed, profile_delivery: hasMlEmbeddingContext(job.profile) ? 'pending' : 'requires_manual_context' };
  }

  async accept(userId: string, snapshotId: string) {
    // Redis is an expiring preview cache. Never hold product row locks while
    // waiting for its network I/O; recheck the durable hash/identity under lock.
    const [preview] = await this.db`SELECT * FROM app.user_github_imports WHERE user_id=${userId}::uuid AND snapshot_id=${snapshotId}::uuid`;
    if (!preview) throw failure('The import preview is not available for this account.');
    const cached = preview.accepted_at ? null : await this.snapshot(userId, preview, true);
    const result = await this.db.begin(async tx => {
      const profile = await this.owner(tx, userId);
      const identity = this.verified(profile);
      const state = await this.state(tx, userId);
      if (state.snapshot_id !== snapshotId || state.github_id !== identity.githubId || state.revoked_at) throw failure('The import preview is not available for this account.');
      if (state.accepted_at) return { profile_version: String(profile.profile_version), completed: profile.onboarding_completed,
        profile_delivery: 'check_readiness', repositories_created: 0, replay: true };
      if (!state.expires_at || new Date(state.expires_at).getTime() <= Date.now()) throw failure('The import preview expired.');
      if (!profile.username || !profile.full_name || !profile.date_of_birth) throw failure('Complete your account details before accepting imported preferences.', 400);
      if (state.snapshot_hash !== preview.snapshot_hash || !cached) throw failure('The import preview changed.');
      const snapshot = cached;
      if (snapshot.github_id !== identity.githubId) throw failure('The verified GitHub account changed.');
      const inferred = importedPreferences(snapshot);
      if (!fields.some(field => inferred[field].length > 0)) throw failure('No public preference signals are available. Choose your interests manually.', 422);
      const baseline = arrays(profile);
      const applied = mergeImportedPreferences(baseline, inferred);
      const created = await new PostgresRepositoryPersistence(this.db).registerDiscoveredRepositories(snapshot.repositories.map(repo => ({
        github_id: repo.github_id, owner_github_id: repo.owner_github_id, full_name: repo.full_name,
        owner: repo.owner, name: repo.name, url: repo.url, description: repo.description,
        primary_language: repo.primary_language, topics: repo.topics, languages: repo.primary_language ? [repo.primary_language] : [],
        star_count: repo.star_count, fork_count: repo.fork_count, open_issues_count: repo.open_issues_count,
        updated_at: repo.updated_at, observed_at: snapshot.collected_at,
      })), tx);
      const saved = await this.writeProfile(tx, userId, applied, true);
      const provenance = { source: 'github_public_activity_v1', collected_at: snapshot.collected_at,
        sources: snapshot.sources, repository_ids: snapshot.repositories.map(repo => ({ github_id: repo.github_id, sources: repo.sources })) };
      await tx`UPDATE app.user_github_imports SET accepted_at=now(),accepted_profile_version=${saved.profile_version}::bigint,
        baseline=${JSON.stringify(baseline)}::jsonb,applied=${JSON.stringify(applied)}::jsonb,provenance=${JSON.stringify(provenance)}::jsonb
        WHERE user_id=${userId}::uuid`;
      return { ...saved, repositories_created: created.length, replay: false };
    });
    await this.cache.del(key(userId, snapshotId)).catch(() => undefined);
    return result;
  }

  async revoke(userId: string, unlinkOperationId?: string) {
    const result = await this.db.begin(async tx => {
      const profile = await this.owner(tx, userId);
      if (unlinkOperationId) {
        const [operation] = await tx`SELECT operation_id,status FROM app.user_github_unlinks
          WHERE user_id=${userId}::uuid`;
        if (operation?.status !== 'prepared' || String(operation.operation_id) !== unlinkOperationId) {
          throw failure('This disconnect operation was superseded.');
        }
      }

      const state = await this.state(tx, userId);
      const current = arrays(profile);
      const baseline = arrays(state.baseline);
      const applied = arrays(state.applied);
      const next = structuredClone(current);
      if (state.accepted_at && !state.revoked_at) for (const field of fields) {
        // A later manual edit owns its whole field; never erase that edit on revoke.
        if (JSON.stringify(current[field]) === JSON.stringify(applied[field])) next[field] = baseline[field];
      }
      if (state.accepted_at && !state.revoked_at) {
        // Retire old preference deliveries in the same transaction that revokes
        // consent, before enqueuing any restored manual-context version. Clearing
        // the token also fences workers which claimed but have not admitted I/O.
        await tx`UPDATE telemetry.ml_outbox
          SET status='superseded',claim_token=NULL,claimed_at=NULL,
            last_error='Onboarding context superseded by GitHub import revocation.'
          WHERE aggregate_id=${userId}::uuid AND job_type='onboard'
            AND status IN ('pending','claimed','dead')
            AND CASE WHEN payload->>'profile_version' ~ '^[0-9]{1,19}$'
              THEN (payload->>'profile_version')::numeric <= ${String(profile.profile_version)}::numeric
              ELSE true END`;
      }
      const meaningful = hasMlEmbeddingContext({ ...next, bio: profile.bio });
      const saved = state.accepted_at && !state.revoked_at
        ? await this.writeProfile(tx, userId, next, meaningful && profile.onboarding_completed)
        : { profile_version: String(profile.profile_version), completed: profile.onboarding_completed, profile_delivery: 'unchanged' };
      await tx`UPDATE app.user_github_imports SET revision=revision+1,revoked_at=now(),collect_token=NULL,collect_until=NULL,
        snapshot_id=NULL,snapshot_hash=NULL,expires_at=NULL,accepted_at=NULL,baseline='{}'::jsonb,applied='{}'::jsonb,provenance='{}'::jsonb
        WHERE user_id=${userId}::uuid`;
      return { ...saved, snapshot_id: state.snapshot_id as string | null };
    });
    if (result.snapshot_id) await this.cache.del(key(userId, result.snapshot_id)).catch(() => undefined);
    const { snapshot_id: _snapshotId, ...response } = result;
    return response;
  }
}
