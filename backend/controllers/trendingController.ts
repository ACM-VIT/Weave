import type { Response } from 'express';
import { sqlClient } from '../db/index.js';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import {
  TrendingSnapshotService,
  TrendingUnavailableError,
  TRENDING_QUERY_TIMEOUT_MS,
  type TrendingPeriod,
  type TrendingSnapshot,
  type TrendingSnapshotSource,
} from '../services/trendingSnapshotService.js';
import { sendError } from '../utils/response.js';

// Explicitly public projections only: the process-shared cache must never
// acquire viewer-specific reactions, saves, private boards or profile data.
export function createTrendingSnapshotSource(client: typeof sqlClient = sqlClient): TrendingSnapshotSource {
  return {
    async available() {
      return client<TrendingSnapshot[]>`
        SELECT DISTINCT ON (s.period) s.period,s.snapshot_id,s.computed_at AS captured_at,
          s.activated_at::text AS activation_version
        FROM app.trending_snapshots s
        WHERE s.active AND s.complete AND s.period IN ('daily','weekly','monthly')
          AND EXISTS (
            SELECT 1 FROM app.trending_snapshot_items i JOIN app.repos r USING(repo_id)
            JOIN app.repo_content c USING(repo_id) JOIN app.repo_engagement e USING(repo_id)
            WHERE i.snapshot_id=s.snapshot_id AND r.status='active'
          )
        ORDER BY s.period,s.computed_at DESC,s.snapshot_id
      `;
    },
    async cards(snapshotId) {
      return client.begin(async tx => {
        // SET LOCAL is restored on commit/rollback; it cannot leak a shorter
        // timeout to another request reusing this pooled connection.
        await tx`SELECT set_config('statement_timeout', ${String(TRENDING_QUERY_TIMEOUT_MS)}, true)`;
        return tx`SELECT i.position,i.score,i.features,r.repo_id,r.github_id,r.full_name,r.owner,r.name,r.url,
        c.description,c.primary_language,c.languages,e.likes_count,e.comments_count,e.views_count,
        COALESCE(stat.star_count,0) AS star_count,COALESCE(stat.fork_count,0) AS fork_count,
        COALESCE(stat.open_issues_count,0) AS open_issues_count,summary.summary
        FROM app.trending_snapshots s JOIN app.trending_snapshot_items i USING(snapshot_id)
        JOIN app.repos r USING(repo_id) JOIN app.repo_content c USING(repo_id) JOIN app.repo_engagement e USING(repo_id)
        LEFT JOIN LATERAL (SELECT star_count,fork_count,open_issues_count FROM app.repo_stat_snapshots x
          WHERE x.repo_id=r.repo_id ORDER BY observed_at DESC LIMIT 1) stat ON true
        LEFT JOIN LATERAL (SELECT summary FROM app.repo_card_summaries x
          WHERE x.repo_id=r.repo_id AND active ORDER BY created_at DESC LIMIT 1) summary ON true
        WHERE s.snapshot_id=${snapshotId}::uuid AND r.status='active'
        ORDER BY i.position LIMIT 100`;
      });
    },
  };
}

export const trendingSnapshotSource = createTrendingSnapshotSource();

export function createTrendingHandler(service: TrendingSnapshotService) {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    if (req.query.period !== undefined
      && (typeof req.query.period !== 'string' || !['daily', 'weekly', 'monthly'].includes(req.query.period))) {
      return sendError(res, 400, 'Invalid trending period.');
    }
    let response;
    try {
      response = await service.get(req.query.period as TrendingPeriod | undefined);
    } catch (error) {
      if (error instanceof TrendingUnavailableError
        || (error instanceof Error && 'code' in error && error.code === '57014')) {
        res.set('Cache-Control', 'no-store');
        res.set('Retry-After', '1');
        return sendError(res, 503, new TrendingUnavailableError().message);
      }
      throw error;
    }
    // Browser/proxy caches must revalidate through authentication and the
    // snapshot lookup. Express handles weak/list/wildcard If-None-Match values
    // and strips the body/content headers for a matching GET or HEAD (304).
    res.set('Cache-Control', 'private, no-cache');
    res.vary('Authorization');
    res.set('ETag', response.etag);
    res.status(200).type('json').send(response.body);
  };
}

export const listTrending = createTrendingHandler(new TrendingSnapshotService(trendingSnapshotSource));
