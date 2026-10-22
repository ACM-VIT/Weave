import crypto from 'node:crypto';

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
  normalizeCanonicalRepositoryReadme,
  repositoryContentHash,
} from '../services/mlRepositoryPayloadService.js';
import { reconcileGithubProfileForIngestion } from '../services/socialProfileService.js';

export class PostgresRepositoryPersistence implements RepositoryPersistencePort {
  async bulkUpsert(input: RepositoryUpsert[]): Promise<RepositoryUpsertResult[]> {
    return sqlClient.begin(async (tx) => {
      const results: RepositoryUpsertResult[] = [];
      const repositories = input.map(normalizeCanonicalRepositoryReadme).sort(
        (a, b) => BigInt(a.github_id) < BigInt(b.github_id) ? -1 : 1,
      );
      const ownerIds = [...new Set(repositories.map((repo) => repo.owner_github_id))]
        .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
      for (const ownerId of ownerIds) {
        await tx`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${'github-owner:' + ownerId},0)
          )
        `;
      }
      for (const repo of repositories) {
        // A repository row does not exist on its first ingestion, so a row lock
        // alone cannot serialize concurrent creators. The transaction-scoped
        // GitHub-ID lock keeps content versions and their outbox payload aligned.
        // Inputs are sorted above so multi-repository batches acquire locks in a
        // consistent order.
        await tx`SELECT pg_advisory_xact_lock(${repo.github_id}::bigint)`;
        const hash = repositoryContentHash(repo);
        const previous = await tx`
          SELECT repo.repo_id,content.content_hash,content.content_version,
                 stats.star_count,stats.fork_count,stats.open_issues_count
          FROM app.repos repo
          LEFT JOIN app.repo_content content ON content.repo_id=repo.repo_id
          LEFT JOIN LATERAL (
            SELECT star_count,fork_count,open_issues_count FROM app.repo_stat_snapshots snapshot
            WHERE snapshot.repo_id=repo.repo_id ORDER BY observed_at DESC LIMIT 1
          ) stats ON true
          WHERE repo.github_id=${repo.github_id}::bigint FOR UPDATE OF repo
        `;
        const rows = await tx`
          INSERT INTO app.repos (github_id,github_node_id,owner_github_id,full_name,owner,name,url)
          VALUES (${repo.github_id}::bigint,${repo.github_node_id ?? null},${repo.owner_github_id}::bigint,${repo.full_name},${repo.owner},${repo.name},${repo.url})
          ON CONFLICT (github_id) DO UPDATE SET github_node_id=EXCLUDED.github_node_id,
            owner_github_id=EXCLUDED.owner_github_id,full_name=EXCLUDED.full_name,owner=EXCLUDED.owner,
            name=EXCLUDED.name,url=EXCLUDED.url,updated_at=now()
          RETURNING repo_id
        `;
        const repoId = String(rows[0].repo_id);
        await reconcileGithubProfileForIngestion(tx, {
          githubId: repo.owner_github_id,
          githubHandle: repo.owner,
        });
        const changed = previous.length === 0 || previous[0].content_hash !== hash;
        const version = changed ? Number(previous[0]?.content_version ?? 0) + 1 : Number(previous[0].content_version);
        await tx`
          INSERT INTO app.repo_content (
            repo_id,description,readme,readme_source_path,readme_default_branch,readme_base_url,
            primary_language,languages,content_hash,content_version,source_updated_at
          ) VALUES (
            ${repoId}::uuid,${repo.description ?? null},${repo.readme ?? null},
            ${repo.readme_source_path ?? null},${repo.readme_default_branch ?? null},${repo.readme_base_url ?? null},
            ${repo.primary_language ?? null},
            ${JSON.stringify(repo.languages ?? [])}::jsonb,${hash},${version},${repo.pushed_at ?? null}::timestamptz
          ) ON CONFLICT (repo_id) DO UPDATE SET description=EXCLUDED.description,readme=EXCLUDED.readme,
            readme_source_path=EXCLUDED.readme_source_path,
            readme_default_branch=EXCLUDED.readme_default_branch,
            readme_base_url=EXCLUDED.readme_base_url,
            primary_language=EXCLUDED.primary_language,languages=EXCLUDED.languages,content_hash=EXCLUDED.content_hash,
            content_version=EXCLUDED.content_version,source_updated_at=EXCLUDED.source_updated_at,updated_at=now()
        `;
        if (changed) {
          await tx`
            UPDATE app.repo_card_summaries SET active=false
            WHERE repo_id=${repoId}::uuid AND active
          `;
        }
        await tx`INSERT INTO app.repo_engagement (repo_id) VALUES (${repoId}::uuid) ON CONFLICT DO NOTHING`;
        await tx`
          INSERT INTO app.repo_stat_snapshots (repo_id,star_count,fork_count,open_issues_count,observed_at)
          VALUES (${repoId}::uuid,${repo.star_count ?? 0},${repo.fork_count ?? 0},${repo.open_issues_count ?? 0},${repo.observed_at}::timestamptz)
          ON CONFLICT (repo_id,observed_at) DO NOTHING
        `;
        await tx`DELETE FROM app.repo_topics WHERE repo_id=${repoId}::uuid`;
        for (const rawTopic of [...new Set(repo.topics ?? [])].sort()) {
          const topic = rawTopic.trim().toLowerCase();
          if (!topic) continue;
          const topicRows = await tx`
            INSERT INTO app.topics (slug,display_name) VALUES (${topic},${rawTopic.trim()})
            ON CONFLICT (slug) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING topic_id
          `;
          await tx`
            INSERT INTO app.repo_topics (repo_id,topic_id) VALUES (${repoId}::uuid,${topicRows[0].topic_id}) ON CONFLICT DO NOTHING
          `;
        }
        if (changed) {
          const payload = { job_id: crypto.randomUUID(), repo_id: repoId, content_version: version,
            repository: buildMlRepositorySource(repo, hash) };
          await tx`
            INSERT INTO telemetry.ml_outbox (job_type,aggregate_id,idempotency_key,payload)
            VALUES ('repo_index',${repoId}::uuid,${`repo_index:${repoId}:${version}`},${JSON.stringify(payload)}::jsonb)
            ON CONFLICT (idempotency_key) DO NOTHING
          `;
        } else {
          const featureVersion = Date.parse(repo.observed_at);
          const payload = {
            job_id: crypto.randomUUID(), repo_id: repoId, feature_version: featureVersion,
            features: buildMlRepositoryFeaturePatch(repo),
          };
          await tx`
            INSERT INTO telemetry.ml_outbox (job_type,aggregate_id,idempotency_key,payload)
            VALUES ('repo_refresh',${repoId}::uuid,
              ${`repo_refresh:ingestion:${repoId}:${featureVersion}`},${JSON.stringify(payload)}::jsonb)
            ON CONFLICT (idempotency_key) DO NOTHING
          `;
        }
        results.push({ github_id: repo.github_id, repo_id: repoId, content_version: version, changed });
      }
      return results;
    });
  }

  async recordTrendingSnapshot(input: TrendingSnapshotInput): Promise<TrendingSnapshotResult> {
    const mappings = await this.bulkUpsert(input.repositories);
    const byGithubId = new Map(mappings.map((mapping) => [mapping.github_id, mapping]));
    return sqlClient.begin(async (tx) => {
      await tx`
        INSERT INTO app.trending_snapshots (snapshot_id,period,source,computed_at,complete,active)
        VALUES (${input.snapshot_id}::uuid,${input.period},${input.source},${input.computed_at}::timestamptz,false,false)
        ON CONFLICT (snapshot_id) DO UPDATE SET source=EXCLUDED.source,computed_at=EXCLUDED.computed_at,
          complete=false,active=false,activated_at=NULL
      `;
      await tx`DELETE FROM app.trending_snapshot_items WHERE snapshot_id=${input.snapshot_id}::uuid`;
      for (const repo of [...input.repositories].sort((a, b) => a.rank - b.rank)) {
        const mapping = byGithubId.get(repo.github_id)!;
        await tx`
          INSERT INTO app.trending_snapshot_items (snapshot_id,position,repo_id,score,features)
          VALUES (${input.snapshot_id}::uuid,${repo.rank},${mapping.repo_id}::uuid,${repo.score ?? null},
            ${JSON.stringify({ star_count: repo.star_count ?? 0, fork_count: repo.fork_count ?? 0 })}::jsonb)
        `;
        const payload = { job_id: crypto.randomUUID(), repo_id: mapping.repo_id,
          feature_version: Date.parse(input.computed_at), features: buildMlRepositoryFeaturePatch(repo) };
        await tx`
          INSERT INTO telemetry.ml_outbox (job_type,aggregate_id,idempotency_key,payload)
          VALUES ('repo_refresh',${mapping.repo_id}::uuid,${`repo_refresh:${input.snapshot_id}:${mapping.repo_id}`},${JSON.stringify(payload)}::jsonb)
          ON CONFLICT (idempotency_key) DO NOTHING
        `;
      }
      await tx`UPDATE app.trending_snapshots SET active=false WHERE period=${input.period} AND snapshot_id<>${input.snapshot_id}::uuid`;
      const rows = await tx`
        UPDATE app.trending_snapshots SET complete=true,active=true,activated_at=now()
        WHERE snapshot_id=${input.snapshot_id}::uuid RETURNING activated_at
      `;
      return { snapshot_id: input.snapshot_id, repository_count: input.repositories.length,
        activated_at: new Date(rows[0].activated_at as string).toISOString() };
    });
  }
}
