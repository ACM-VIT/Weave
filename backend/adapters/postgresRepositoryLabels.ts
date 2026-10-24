import { sqlClient } from '../db/index.js';
import { REPOSITORY_LABEL_POLICY as policy, RepositoryLabelService, type RepositoryLabelSource,
  type RepositoryLabelEvidence, type RecentLikesEvidence } from '../services/repositoryLabelService.js';

export function createRepositoryLabelSource(client: typeof sqlClient = sqlClient): RepositoryLabelSource {
  return {
    async repositories(repoIds) {
      return client.begin(async tx => {
        await tx`SELECT set_config('statement_timeout', ${String(policy.queryTimeoutMs)}, true)`;
        // The ML publisher enumerates github-trending ranks from 1 and stores
        // them unchanged. The backend's zero-based search-corpus snapshot has a
        // different source and must never become an official GitHub rank badge.
        const rows = await tx`SELECT r.repo_id, trending.position AS trending_rank,
          trending.computed_at AS trending_observed_at,stat.star_count,stat.observed_at AS stats_observed_at
          FROM app.repos r
          LEFT JOIN LATERAL (
            SELECT i.position,s.computed_at FROM app.trending_snapshots s
            JOIN app.trending_snapshot_items i USING(snapshot_id)
            WHERE s.active AND s.complete AND s.period='daily' AND s.source='github-trending' AND i.repo_id=r.repo_id
            ORDER BY s.computed_at DESC,s.snapshot_id LIMIT 1
          ) trending ON true
          LEFT JOIN LATERAL (
            SELECT star_count,observed_at FROM app.repo_stat_snapshots
            WHERE repo_id=r.repo_id ORDER BY observed_at DESC LIMIT 1
          ) stat ON true
          WHERE r.repo_id=ANY(${repoIds}::uuid[]) AND r.status='active'`;
        return rows.map(row => ({ ...row, repo_id: String(row.repo_id),
          trending_rank: row.trending_rank == null ? null : Number(row.trending_rank),
          star_count: row.star_count == null ? null : Number(row.star_count),
        })) as RepositoryLabelEvidence[];
      });
    },
    async recentLikes(referenceTime) {
      return client.begin(async tx => {
        await tx`SELECT set_config('statement_timeout', ${String(policy.queryTimeoutMs)}, true)`;
        // One current reaction per user/repo. Unlike removes the row, duplicate
        // likes do not refresh updated_at; server time avoids client clock skew.
        // Rank the whole corpus BEFORE matching the feed page's repository IDs.
        const rows = await tx`SELECT reaction.repo_id,count(*)::integer AS count,
          row_number() OVER (ORDER BY count(*) DESC,reaction.repo_id)::integer AS rank
          FROM app.reactions reaction JOIN app.users u ON u.user_id=reaction.user_id AND u.status='active'
          JOIN app.repos r ON r.repo_id=reaction.repo_id AND r.status='active'
          WHERE reaction.reaction='like'
            AND reaction.updated_at>=${referenceTime.toISOString()}::timestamptz-(${policy.recentLikesWindowHours}::integer*interval '1 hour')
            AND reaction.updated_at<=${referenceTime.toISOString()}::timestamptz
          GROUP BY reaction.repo_id HAVING count(*)>=${policy.recentLikesMinimum}
          ORDER BY count(*) DESC,reaction.repo_id LIMIT ${policy.recentLikesTop}`;
        return rows.map(row => ({ repo_id: String(row.repo_id), count: Number(row.count), rank: Number(row.rank) })) satisfies RecentLikesEvidence[];
      });
    },
  };
}

export const repositoryLabels = new RepositoryLabelService(createRepositoryLabelSource());
