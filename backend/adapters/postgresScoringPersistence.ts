import postgres, { type Sql } from 'postgres';
import type { ScoringCaptureConfig } from '../config/scoringCapture.js';
import type { CaptureRetentionPolicy, ScoringPersistenceResult } from '../contracts/scoringCapture.js';
import type { ScoringPersistencePort } from '../ports/scoringPersistencePort.js';
import type { ValidatedScoringGeneration } from '../services/scoringCaptureValidation.js';

export class ScoringPersistenceError extends Error {
  constructor(readonly reason: 'invalid' | 'conflict' | 'expired' | 'permission' | 'unavailable') {
    super(`SCORING_PERSISTENCE_${reason.toUpperCase()}`); this.name = 'ScoringPersistenceError';
  }
}

/** This adapter never imports or falls back to the ordinary product SQL pool. */
export class PostgresScoringPersistence implements ScoringPersistencePort {
  #permission: Promise<void> | undefined;
  constructor(private readonly writer: Sql) {}
  private verifyPermission(): Promise<void> {
    if (this.#permission) return this.#permission;
    const permission = (async () => {
      const [role] = await this.writer`
        SELECT pg_has_role(current_user,'ghsocial_scoring_writer','MEMBER') AS writer,
          pg_has_role(current_user,'ghsocial_scoring_exporter','MEMBER') AS exporter,
          pg_has_role(current_user,'ghsocial_scoring_retention','MEMBER') AS retention,
          pg_has_role(current_user,'ghsocial_backend','MEMBER') AS product,
          rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,
          has_any_column_privilege('private_scoring.scoring_inputs','SELECT') AS reads_inputs,
          has_any_column_privilege('private_scoring.scoring_generations','SELECT') AS reads_context,
          EXISTS(SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname IN ('app','telemetry') AND relation.relkind IN ('r','p','v','m','f')
              AND has_any_column_privilege(relation.oid,'SELECT')) AS reads_product
        FROM pg_roles WHERE rolname=current_user
      `;
      if (!role?.writer || role.product || role.reads_product || role.exporter || role.retention || role.rolsuper || role.rolcreaterole
        || role.rolcreatedb || role.rolreplication || role.rolbypassrls || role.reads_inputs || role.reads_context) {
        throw new ScoringPersistenceError('permission');
      }
    })();
    this.#permission = permission;
    void permission.catch(() => { if (this.#permission === permission) this.#permission = undefined; });
    return permission;
  }

  async recordWitness(userId: string, generationId: string, event: 'published' | 'stale'): Promise<boolean> {
    try {
      await this.verifyPermission();
      const [row] = await this.writer`SELECT private_scoring.record_generation_witness(${userId}::uuid,${generationId}::uuid,${event}::text) AS accepted`;
      return row?.accepted === true;
    } catch (error) {
      if (error instanceof ScoringPersistenceError) throw error;
      throw new ScoringPersistenceError('unavailable');
    }
  }

  async reconcilePublicationWitnesses(userIds: readonly string[], limit: number): Promise<number> {
    if (userIds.length < 1 || userIds.length > 100 || !Number.isInteger(limit) || limit < 1 || limit > 100
      || userIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
      throw new ScoringPersistenceError('invalid');
    }
    try {
      await this.verifyPermission();
      const [row] = await this.writer`SELECT private_scoring.reconcile_publication_witnesses(${[...userIds]}::uuid[],${limit}::integer) AS repaired`;
      if (!Number.isInteger(row?.repaired) || row.repaired < 0 || row.repaired > limit) throw new ScoringPersistenceError('unavailable');
      return row.repaired;
    } catch {
      throw new ScoringPersistenceError('unavailable');
    }
  }

  async persist(generation: ValidatedScoringGeneration, policy: CaptureRetentionPolicy): Promise<ScoringPersistenceResult> {
    // Materialize a bounded, validated immutable value before opening SQL work.
    const payload = generation.serializeForPersistence(policy);
    try {
      await this.verifyPermission();
      const [row] = await this.writer`SELECT private_scoring.persist_generation(${payload}::text) AS result`;
      const result: unknown = row?.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ScoringPersistenceError('unavailable');
      const value = result as Record<string, unknown>;
      if (Object.keys(value).sort().join(',') !== 'expires_at,generation_id,references'
        || value.generation_id !== generation.references[0]?.generation_id || typeof value.expires_at !== 'string'
        || !Number.isFinite(Date.parse(value.expires_at)) || !Array.isArray(value.references)
        || value.references.length !== generation.references.length
        || value.references.some((reference: unknown, index: number) => {
          if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return true;
          const row = reference as Record<string, unknown>, expected = generation.references[index];
          return Object.keys(row).sort().join(',') !== 'generation_id,record_digest,repo_id'
            || row.generation_id !== expected.generation_id || row.repo_id !== expected.repo_id || row.record_digest !== expected.record_digest;
        })) throw new ScoringPersistenceError('unavailable');
      return { generationId: value.generation_id as string, expiresAt: new Date(value.expires_at).toISOString(),
        references: generation.references };
    } catch (error) {
      if (error instanceof ScoringPersistenceError) throw error;
      if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
        if (error.code === '22023') throw new ScoringPersistenceError('invalid');
        if (error.code === 'P0001' && error.message === 'SCORING_CAPTURE_CONFLICT') throw new ScoringPersistenceError('conflict');
        if (error.code === 'P0001' && error.message === 'SCORING_CAPTURE_EXPIRED') throw new ScoringPersistenceError('expired');
      }
      // Do not retain a database error/cause: it can contain bound private data.
      throw new ScoringPersistenceError('unavailable');
    }
  }
}

/** Disabled callers instantiate neither a private connection pool nor a writer. */
export function createPrivateScoringPersistence(config: ScoringCaptureConfig): {
  port: ScoringPersistencePort; close(): Promise<void>;
} | null {
  if (!config.enabled) return null;
  const writer = postgres(config.writerDatabaseUrl, { max: 2, prepare: false,
    connection: { statement_timeout: config.writeTimeoutMs }, connect_timeout: 2, idle_timeout: 20 });
  return { port: new PostgresScoringPersistence(writer), close: () => writer.end({ timeout: 1 }) };
}
