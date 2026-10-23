import { withOutboxTrace } from '../observability/tracing.js';
import crypto from 'node:crypto';
import { mergeRepositoryLineage, type RepositoryLineage } from '../services/repositoryLineage.js';
import type { Sql, TransactionSql } from 'postgres';

import type {
  RepositoryUpsert,
  RepositoryUpsertResult,
  TrendingSnapshotInput,
  TrendingSnapshotResult,
} from '../contracts/ingestion.v2.js';
import { sqlClient } from '../db/index.js';
import type { RepositoryPersistencePort } from '../ports/repositoryPersistencePort.js';
import {
  buildMlRepositoryFeaturePatch,
  buildMlRepositorySource,
  repositoryContentHash,
  repositoryRefreshIdempotencyKey,
} from '../services/mlRepositoryPayloadService.js';
import {
  planRepositoryObservationBatches,
  type RepositoryObservation,
} from '../services/repositoryIngestionBatch.js';
import { enqueueReadmeSummaryBatch } from '../services/readmeSummaryService.js';
import { isValidUuid } from '../utils/validators.js';
import { canonicalGithubProfileSubject, reconcileGithubProfileForIngestion } from '../services/socialProfileService.js';

type OutboxInput = {
  job_type: 'repo_index' | 'repo_refresh';
  aggregate_id: string;
  idempotency_key: string;
  payload: object;
};

function refreshInput(
  repository: RepositoryUpsert, repoId: string, featureVersion: number, requiredContentVersion: number,
): OutboxInput {
  const features = buildMlRepositoryFeaturePatch(repository);
  return {
    job_type: 'repo_refresh', aggregate_id: repoId,
    idempotency_key: repositoryRefreshIdempotencyKey(repoId, featureVersion, features, requiredContentVersion),
    payload: { job_id: crypto.randomUUID(), repo_id: repoId, feature_version: featureVersion, features,
      required_content_version: requiredContentVersion },
  };
}

async function insertOutbox(tx: TransactionSql, input: OutboxInput[]): Promise<void> {
  if (input.length === 0) return;
  await tx`
    INSERT INTO telemetry.ml_outbox (job_type,aggregate_id,idempotency_key,payload)
    SELECT job_type,aggregate_id::uuid,idempotency_key,payload
    FROM jsonb_to_recordset(${JSON.stringify(input.map(row => ({ ...row, payload: withOutboxTrace(row.payload) })))}::text::jsonb)
      AS incoming(job_type text,aggregate_id text,idempotency_key text,payload jsonb)
    ORDER BY aggregate_id,job_type,idempotency_key
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
}

export class PostgresRepositoryPersistence implements RepositoryPersistencePort {
  constructor(private readonly db: Sql = sqlClient) {}

  async bulkUpsert(input: RepositoryUpsert[]): Promise<RepositoryUpsertResult[]> {
    const batches = planRepositoryObservationBatches(input);
    return this.db.begin(async (tx) => {
      await this.lockIngestion(tx, batches);
      return this.upsertBatches(tx, batches);
    });
  }

  /** Public graph discovery may create missing records, never replace richer corpus content. */
  async registerDiscoveredRepositories(input: RepositoryUpsert[], transaction?: TransactionSql): Promise<RepositoryUpsertResult[]> {
    if (!input.length) return [];
    if (input.length > 1_500) throw new Error('Public graph discovery exceeds its bounded repository limit.');
    const ids = new Set(input.map(repo => BigInt(repo.github_id).toString()));
    if (ids.size !== input.length) throw new Error('Public graph discovery requires unique canonical GitHub identities.');
    const batches: RepositoryObservation[][] = [];
    let order = 0;
    for (let offset = 0; offset < input.length; offset += 100) {
      for (const batch of planRepositoryObservationBatches(input.slice(offset, offset + 100))) {
        batches.push(batch.map(item => ({ ...item, order: order++ })));
      }
    }
    const apply = async (tx: TransactionSql) => {
      // Acquire the complete sorted canonical lock set before checking absence.
      // A preflight SELECT followed by ordinary upsert races with real ingestion.
      await this.lockIngestion(tx, batches);
      const existing = await tx`SELECT github_id::text FROM app.repos WHERE github_id=ANY(${[...ids]}::bigint[])`;
      const known = new Set(existing.map(row => String(row.github_id)));
      // Discovery is create-only: a known repository may have moved while its
      // old name is reused in the public snapshot. Do not overwrite its rich
      // canonical content or let that stale name roll back the whole import.
      const names = batches.flat().map(item => item.repository.full_name.toLowerCase());
      const occupied = await tx`SELECT lower(full_name) AS full_name FROM app.repos
        WHERE lower(full_name)=ANY(${names}::text[])`;
      const occupiedNames = new Set(occupied.map(row => String(row.full_name)));
      const missing = batches.map(batch => batch.filter(item => {
        const name = item.repository.full_name.toLowerCase();
        if (known.has(BigInt(item.repository.github_id).toString()) || occupiedNames.has(name)) return false;
        occupiedNames.add(name);
        return true;
      })).filter(batch => batch.length > 0);
      return this.upsertBatches(tx, missing);
    };
    return transaction ? apply(transaction) : this.db.begin(apply);
  }

  private async lockIngestion(
    tx: TransactionSql,
    batches: RepositoryObservation[][],
    snapshot?: TrendingSnapshotInput,
  ): Promise<void> {
    const repositories = batches.flat().map(({ repository }) => repository);
    const identities = repositories.map((repo) => ({
      github_id: BigInt(repo.github_id).toString(),
      owner_github_id: canonicalGithubProfileSubject(repo.owner_github_id),
      owner: repo.owner, topics: repo.topics ?? [],
    }));
    // Sort actual signed advisory keys, including collisions between namespaces.
    // A materialized ordered relation keeps lock acquisition out of a reorderable
    // projection. No repository/profile write occurs before this complete lock set.
    await tx`
      WITH incoming AS MATERIALIZED (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(identities)}::text::jsonb)
          AS value(github_id text,owner_github_id text,owner text,topics jsonb)
      ), locks AS MATERIALIZED (
        SELECT lock_key FROM (
          SELECT github_id::bigint AS lock_key FROM incoming
          UNION SELECT hashtextextended('github-owner:' || owner_github_id,0) FROM incoming
          UNION SELECT hashtextextended('github-handle:' || lower(owner),0) FROM incoming
          UNION SELECT hashtextextended('github-topic:' || topic,0) FROM incoming
            CROSS JOIN LATERAL jsonb_array_elements_text(topics) AS slugs(topic)
          UNION SELECT hashtextextended(value,0)
            FROM jsonb_array_elements_text(${JSON.stringify(snapshot ? [
              `trending-period:${snapshot.period}`, `trending-snapshot:${snapshot.snapshot_id}`,
            ] : [])}::text::jsonb) AS extra(value)
        ) keys ORDER BY lock_key
      )
      SELECT pg_advisory_xact_lock(lock_key) FROM locks
    `;
    // Identity reconciliation can touch numeric-ID matches and handle collisions.
    // Lock their union once in the same order as the shared verified-claim path.
    await tx`
      SELECT profile_id FROM app.social_profiles profile
      WHERE provider='github' AND EXISTS (
        SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(identities)}::text::jsonb)
          AS incoming(github_id text,owner_github_id text,owner text)
        WHERE ltrim(profile.provider_subject,'0')=incoming.owner_github_id
          OR (profile.status='active' AND lower(profile.handle)=lower(incoming.owner))
      )
      ORDER BY profile_id FOR UPDATE
    `;
  }

  private async upsertBatches(
    tx: TransactionSql,
    batches: RepositoryObservation[][],
  ): Promise<RepositoryUpsertResult[]> {
    // Reuse the collision/follow reconciliation, keeping conflicting owner-handle
    // observations in their original sorted order rather than dropping history.
    const ordered = batches.flat().sort((left, right) => left.order - right.order);
    for (const { repository: repo } of ordered) {
      const ownerId = canonicalGithubProfileSubject(repo.owner_github_id);
      await reconcileGithubProfileForIngestion(tx, { githubId: ownerId, githubHandle: repo.owner });
    }

    const results: Array<RepositoryUpsertResult & { order: number }> = [];
    for (const batch of batches) {
      const repositories = batch.map(({ repository }) => repository);
      const source = JSON.stringify(repositories);
      const previousRows = await tx`
        SELECT repo.github_id::text,repo.repo_id,content.content_hash,content.content_version,
          repo.is_fork,repo.fork_parent_github_id::text,repo.fork_family_github_id::text,repo.lineage_source,
          to_char(repo.lineage_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lineage_observed_at
        FROM app.repos repo LEFT JOIN app.repo_content content USING(repo_id)
        WHERE repo.github_id IN (
          SELECT github_id::bigint FROM jsonb_to_recordset(${source}::text::jsonb) AS incoming(github_id text)
        )
        ORDER BY repo.github_id FOR UPDATE OF repo
      `;
      const previous = new Map(previousRows.map((row) => [String(row.github_id), row]));
      const prepared = batch.map(({ repository: repo, order }) => {
        const old = previous.get(BigInt(repo.github_id).toString());
        // This orders ancestry observations only. Owner/name arrival ordering
        // and profile reconciliation above retain their existing behavior.
        const canonical = { ...repo, ...mergeRepositoryLineage(repo, (old ?? {}) as RepositoryLineage, repo.github_id) };
        const hash = repositoryContentHash(canonical);
        const changed = !old || old.content_hash !== hash;
        return { ...canonical, content_hash: hash,
          content_version: changed ? Number(old?.content_version ?? 0) + 1 : Number(old.content_version),
          changed, order };
      });
      const preparedSource = JSON.stringify(prepared);
      const repoRows = await tx`
        WITH upserted AS (
          INSERT INTO app.repos (github_id,github_node_id,owner_github_id,full_name,owner,name,url,
            is_fork,fork_parent_github_id,fork_family_github_id,lineage_source,lineage_observed_at)
          SELECT github_id::bigint,github_node_id,owner_github_id::bigint,full_name,owner,name,url,
            is_fork,fork_parent_github_id::bigint,fork_family_github_id::bigint,lineage_source,lineage_observed_at
          FROM jsonb_to_recordset(${preparedSource}::text::jsonb) AS incoming(
            github_id text,github_node_id text,owner_github_id text,full_name text,owner text,name text,url text,
            is_fork boolean,fork_parent_github_id text,fork_family_github_id text,lineage_source text,lineage_observed_at timestamptz
          ) ORDER BY github_id::bigint
          ON CONFLICT (github_id) DO UPDATE SET github_node_id=EXCLUDED.github_node_id,
            owner_github_id=EXCLUDED.owner_github_id,full_name=EXCLUDED.full_name,owner=EXCLUDED.owner,
            name=EXCLUDED.name,url=EXCLUDED.url,is_fork=EXCLUDED.is_fork,
            fork_parent_github_id=EXCLUDED.fork_parent_github_id,fork_family_github_id=EXCLUDED.fork_family_github_id,
            lineage_source=EXCLUDED.lineage_source,lineage_observed_at=EXCLUDED.lineage_observed_at,updated_at=clock_timestamp()
          WHERE (app.repos.github_node_id,app.repos.owner_github_id,app.repos.full_name,
                 app.repos.owner,app.repos.name,app.repos.url,app.repos.is_fork,app.repos.fork_parent_github_id,
                 app.repos.fork_family_github_id,app.repos.lineage_source,app.repos.lineage_observed_at)
            IS DISTINCT FROM (EXCLUDED.github_node_id,EXCLUDED.owner_github_id,EXCLUDED.full_name,
                              EXCLUDED.owner,EXCLUDED.name,EXCLUDED.url,EXCLUDED.is_fork,EXCLUDED.fork_parent_github_id,
                              EXCLUDED.fork_family_github_id,EXCLUDED.lineage_source,EXCLUDED.lineage_observed_at)
            OR EXCLUDED.github_id IN (
              SELECT github_id::bigint FROM jsonb_to_recordset(${preparedSource}::text::jsonb)
                AS changed_repositories(github_id text,changed boolean) WHERE changed
            )
          RETURNING github_id::text,repo_id
        )
        SELECT * FROM upserted
        UNION ALL
        SELECT repo.github_id::text,repo.repo_id FROM app.repos repo
        WHERE repo.github_id IN (
          SELECT github_id::bigint FROM jsonb_to_recordset(${preparedSource}::text::jsonb) AS incoming(github_id text)
        ) AND NOT EXISTS (SELECT 1 FROM upserted WHERE upserted.repo_id=repo.repo_id)
      `;
      const ids = new Map(repoRows.map((row) => [String(row.github_id), String(row.repo_id)]));
      const staged = prepared.map((repo) => ({ ...repo,
        repo_id: ids.get(BigInt(repo.github_id).toString())!,
      }));
      const stagedSource = JSON.stringify(staged);
      await tx`
        INSERT INTO app.repo_content (
          repo_id,description,readme,readme_source_path,readme_default_branch,readme_base_url,
          primary_language,languages,content_hash,content_version,source_updated_at
        )
        SELECT repo_id::uuid,description,readme,readme_source_path,readme_default_branch,readme_base_url,
          primary_language,COALESCE(languages,'[]'::jsonb),content_hash,content_version,pushed_at
        FROM jsonb_to_recordset(${stagedSource}::text::jsonb) AS incoming(
          repo_id text,description text,readme text,readme_source_path text,readme_default_branch text,
          readme_base_url text,primary_language text,languages jsonb,content_hash text,
          content_version integer,pushed_at timestamptz,changed boolean
        ) WHERE changed ORDER BY repo_id
        ON CONFLICT (repo_id) DO UPDATE SET description=EXCLUDED.description,readme=EXCLUDED.readme,
          readme_source_path=EXCLUDED.readme_source_path,readme_default_branch=EXCLUDED.readme_default_branch,
          readme_base_url=EXCLUDED.readme_base_url,primary_language=EXCLUDED.primary_language,
          languages=EXCLUDED.languages,content_hash=EXCLUDED.content_hash,content_version=EXCLUDED.content_version,
          source_updated_at=EXCLUDED.source_updated_at,updated_at=now()
        WHERE app.repo_content.content_hash IS DISTINCT FROM EXCLUDED.content_hash
      `;
      await tx`
        UPDATE app.repo_content content SET source_updated_at=incoming.pushed_at
        FROM jsonb_to_recordset(${stagedSource}::text::jsonb)
          AS incoming(repo_id text,pushed_at timestamptz,changed boolean)
        WHERE content.repo_id=incoming.repo_id::uuid AND NOT incoming.changed
          AND content.source_updated_at IS DISTINCT FROM incoming.pushed_at
      `;
      await tx`
        UPDATE app.repo_card_summaries summary SET active=false
        FROM jsonb_to_recordset(${stagedSource}::text::jsonb) AS incoming(repo_id text,changed boolean)
        WHERE summary.repo_id=incoming.repo_id::uuid AND incoming.changed AND summary.active
      `;
      // Include unchanged content: a missing job or a new prompt still needs enqueue.
      await enqueueReadmeSummaryBatch(tx, staged.map(({ repo_id, content_hash, content_version }) => ({
        repo_id, content_hash, content_version,
      })));
      await tx`
        INSERT INTO app.repo_engagement (repo_id)
        SELECT repo_id::uuid FROM jsonb_to_recordset(${stagedSource}::text::jsonb) AS incoming(repo_id text)
        ORDER BY repo_id ON CONFLICT DO NOTHING
      `;
      await tx`
        INSERT INTO app.repo_stat_snapshots (repo_id,star_count,fork_count,open_issues_count,observed_at)
        SELECT repo_id::uuid,COALESCE(star_count,0),COALESCE(fork_count,0),COALESCE(open_issues_count,0),observed_at
        FROM jsonb_to_recordset(${stagedSource}::text::jsonb) AS incoming(
          repo_id text,star_count integer,fork_count integer,open_issues_count integer,observed_at timestamptz
        ) ORDER BY repo_id,observed_at ON CONFLICT (repo_id,observed_at) DO NOTHING
      `;
      const changed = staged.filter((repo) => repo.changed);
      if (changed.length > 0) {
        const changedSource = JSON.stringify(changed.map((repo) => ({ repo_id: repo.repo_id, topics: repo.topics })));
        await tx`
          INSERT INTO app.topics (slug,display_name)
          SELECT DISTINCT topic AS slug,topic AS display_name
          FROM jsonb_to_recordset(${changedSource}::text::jsonb) AS incoming(repo_id text,topics jsonb)
          CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(topics,'[]'::jsonb)) AS topics(topic)
          ORDER BY slug ON CONFLICT (slug) DO NOTHING
        `;
        await tx`
          DELETE FROM app.repo_topics link USING
            jsonb_to_recordset(${changedSource}::text::jsonb) AS incoming(repo_id text,topics jsonb)
          WHERE link.repo_id=incoming.repo_id::uuid
        `;
        await tx`
          INSERT INTO app.repo_topics (repo_id,topic_id)
          SELECT incoming.repo_id::uuid,topic.topic_id
          FROM jsonb_to_recordset(${changedSource}::text::jsonb) AS incoming(repo_id text,topics jsonb)
          CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(topics,'[]'::jsonb)) AS slugs(slug)
          JOIN app.topics topic ON topic.slug=slugs.slug
          ORDER BY incoming.repo_id,topic.topic_id ON CONFLICT DO NOTHING
        `;
      }
      const jobs: OutboxInput[] = [];
      for (const repo of staged) {
        if (repo.changed) jobs.push({
          job_type: 'repo_index', aggregate_id: repo.repo_id,
          idempotency_key: `repo_index:${repo.repo_id}:${repo.content_version}`,
          payload: { job_id: crypto.randomUUID(), repo_id: repo.repo_id, content_version: repo.content_version,
            repository: buildMlRepositorySource(repo, repo.content_hash) },
        });
        jobs.push(refreshInput(repo, repo.repo_id, Date.parse(repo.observed_at), repo.content_version));
        results.push({ github_id: repo.github_id, repo_id: repo.repo_id,
          content_version: repo.content_version, changed: repo.changed, order: repo.order });
      }
      await insertOutbox(tx, jobs);
    }
    return results.sort((left, right) => left.order - right.order).map(({ order: _order, ...result }) => result);
  }

  async recordTrendingSnapshot(input: TrendingSnapshotInput): Promise<TrendingSnapshotResult> {
    if (!isValidUuid(input.snapshot_id)) throw new Error('Trending snapshots require a canonical UUID.');
    input = { ...input, snapshot_id: input.snapshot_id.toLowerCase() };
    const batches = planRepositoryObservationBatches(input.repositories);
    if (new Set(input.repositories.map((repo) => BigInt(repo.github_id).toString())).size !== input.repositories.length
      || new Set(input.repositories.map((repo) => repo.rank)).size !== input.repositories.length
      || input.repositories.some((repo) => !Number.isInteger(repo.rank) || repo.rank < 0 || repo.rank > 32_767)) {
      throw new Error('Trending snapshots require unique repositories and smallint ranks.');
    }
    return this.db.begin(async (tx) => {
      await this.lockIngestion(tx, batches, input);
      const existing = await tx`
        SELECT period FROM app.trending_snapshots WHERE snapshot_id=${input.snapshot_id}::uuid FOR UPDATE
      `;
      if (existing[0] && existing[0].period !== input.period) {
        throw new Error('A Trending snapshot cannot change its period on replay.');
      }
      const mappings = await this.upsertBatches(tx, batches);
      const byGithubId = new Map(mappings.map((mapping) => [mapping.github_id, mapping]));
      const snapshots = await tx`
        INSERT INTO app.trending_snapshots (snapshot_id,period,source,computed_at,complete,active)
        VALUES (${input.snapshot_id}::uuid,${input.period},${input.source},${input.computed_at}::timestamptz,false,false)
        ON CONFLICT (snapshot_id) DO UPDATE SET source=EXCLUDED.source,computed_at=EXCLUDED.computed_at,
          complete=false,active=false,activated_at=NULL
        WHERE app.trending_snapshots.period=EXCLUDED.period
        RETURNING snapshot_id
      `;
      if (snapshots.length === 0) throw new Error('A Trending snapshot cannot change its period on replay.');
      await tx`DELETE FROM app.trending_snapshot_items WHERE snapshot_id=${input.snapshot_id}::uuid`;
      const ranked = [...input.repositories].sort((left, right) => left.rank - right.rank).map((repo) => ({
        repo_id: byGithubId.get(repo.github_id)!.repo_id, position: repo.rank, score: repo.score ?? null,
        features: buildMlRepositoryFeaturePatch(repo),
      }));
      await tx`
        INSERT INTO app.trending_snapshot_items (snapshot_id,position,repo_id,score,features)
        SELECT ${input.snapshot_id}::uuid,position,repo_id::uuid,score,features
        FROM jsonb_to_recordset(${JSON.stringify(ranked)}::text::jsonb)
          AS incoming(repo_id text,position smallint,score double precision,features jsonb)
        ORDER BY position
      `;
      await insertOutbox(tx, input.repositories.map((repo) => refreshInput(
        repo, byGithubId.get(repo.github_id)!.repo_id, Date.parse(input.computed_at),
        byGithubId.get(repo.github_id)!.content_version,
      )));
      await tx`
        UPDATE app.trending_snapshots SET active=false
        WHERE period=${input.period} AND active AND snapshot_id<>${input.snapshot_id}::uuid
      `;
      const rows = await tx`
        UPDATE app.trending_snapshots SET complete=true,active=true,activated_at=now()
        WHERE snapshot_id=${input.snapshot_id}::uuid RETURNING activated_at
      `;
      return { snapshot_id: input.snapshot_id, repository_count: input.repositories.length,
        activated_at: new Date(rows[0].activated_at as string).toISOString() };
    });
  }
}
