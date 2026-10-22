import { createHash } from 'node:crypto';
import { readmeSummaryProjection } from '../services/readmeSummaryService.js';
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
        return tx`SELECT i.position,i.score,i.features,r.repo_id,r.github_id,r.owner_github_id,r.full_name,r.owner,r.name,r.url,r.status,r.created_at,r.updated_at,
        c.description,c.primary_language,c.languages,c.content_version,
        ${tx.unsafe(readmeSummaryProjection('r','c'))},c.readme AS readme_md,
        to_jsonb(c)->>'readme_source_path' AS readme_source_path,
        to_jsonb(c)->>'readme_default_branch' AS readme_default_branch,
        to_jsonb(c)->>'readme_base_url' AS readme_base_url,c.updated_at AS content_updated_at,c.source_updated_at,
        e.likes_count,e.dislikes_count,e.saves_count,e.comments_count,e.views_count,
        COALESCE(stat.star_count,0) AS star_count,COALESCE(stat.fork_count,0) AS fork_count,
        COALESCE(stat.open_issues_count,0) AS open_issues_count,stat.observed_at AS stats_observed_at,
        summary.summary_id,summary.summary,summary.highlights AS summary_highlights,
        summary.prompt_version AS summary_prompt_version,summary.model_version AS summary_model_version,
        summary.format_version AS summary_format_version,summary.source AS summary_source,
        COALESCE((SELECT json_agg(topic.slug ORDER BY topic.slug)
          FROM app.repo_topics repository_topic JOIN app.topics topic USING(topic_id)
          WHERE repository_topic.repo_id=r.repo_id),'[]'::json) AS topics
        FROM app.trending_snapshots s JOIN app.trending_snapshot_items i USING(snapshot_id)
        JOIN app.repos r USING(repo_id) JOIN app.repo_content c USING(repo_id) JOIN app.repo_engagement e USING(repo_id)
        LEFT JOIN LATERAL (SELECT star_count,fork_count,open_issues_count,observed_at FROM app.repo_stat_snapshots x
          WHERE x.repo_id=r.repo_id ORDER BY observed_at DESC LIMIT 1) stat ON true
        LEFT JOIN LATERAL (SELECT x.summary_id,x.summary,to_jsonb(x)->'highlights' AS highlights,
          to_jsonb(x)->>'prompt_version' AS prompt_version,x.model_version,
          to_jsonb(x)->>'format_version' AS format_version,to_jsonb(x)->>'source' AS source
          FROM app.repo_card_summaries x WHERE x.repo_id=r.repo_id AND active
            AND x.content_version=c.content_version
            AND to_jsonb(x)->>'source' IN ('generated','description_fallback')
          ORDER BY created_at DESC LIMIT 1) summary ON true
        WHERE s.snapshot_id=${snapshotId}::uuid AND r.status='active'
        ORDER BY i.position LIMIT 100`;
      });
    },
  };
}

export const trendingSnapshotSource = createTrendingSnapshotSource();

export type TrendingViewerStateLoader = (viewer: string, repoIds: string[]) => Promise<readonly Record<string, unknown>[]>;

// These fields are read afresh per request and never enter the shared cache.
export const loadTrendingViewerState: TrendingViewerStateLoader = async (viewer, repoIds) => {
  if (!repoIds.length) return [];
  return sqlClient.begin(async tx => {
    await tx`SELECT set_config('statement_timeout', ${String(TRENDING_QUERY_TIMEOUT_MS)}, true)`;
    return tx`SELECT r.repo_id,viewer_reaction.reaction AS viewer_reaction,
      (viewer_save.repo_id IS NOT NULL) AS viewer_saved,
      COALESCE((SELECT json_agg(selection.list_id ORDER BY selection.list_id) FROM (
        SELECT 'collection:' || collection.collection_id::text AS list_id
        FROM app.collection_repos membership JOIN app.board_collections collection USING(collection_id)
        WHERE membership.repo_id=r.repo_id AND collection.user_id=${viewer}::uuid
        UNION ALL
        SELECT 'legacy-board:' || board.board_id::text AS list_id
        FROM app.board_repos membership JOIN app.boards board USING(board_id)
        WHERE membership.repo_id=r.repo_id AND board.user_id=${viewer}::uuid
      ) selection),'[]'::json) AS selected_list_ids
      FROM app.repos r
      LEFT JOIN app.reactions viewer_reaction ON viewer_reaction.repo_id=r.repo_id AND viewer_reaction.user_id=${viewer}::uuid
      LEFT JOIN app.saves viewer_save ON viewer_save.repo_id=r.repo_id AND viewer_save.user_id=${viewer}::uuid
      WHERE r.repo_id=ANY(${repoIds}::uuid[])`;
  });
};

export function createTrendingHandler(service: TrendingSnapshotService, viewerState?: TrendingViewerStateLoader) {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    if (req.query.period !== undefined
      && (typeof req.query.period !== 'string' || !['daily', 'weekly', 'monthly'].includes(req.query.period))) {
      return sendError(res, 400, 'Invalid trending period.');
    }
    if (viewerState && !req.user?.userId) return sendError(res, 401, 'Authentication required.');
    let response;
    try {
      response = await service.get(req.query.period as TrendingPeriod | undefined);
      if (viewerState) {
        const payload = JSON.parse(response.body) as { data: { items: Record<string, unknown>[] } };
        const states = await viewerState(req.user!.userId, payload.data.items.map(item => String(item.repo_id)));
        const byId = new Map(states.map(state => [String(state.repo_id), state]));
        payload.data.items = payload.data.items.map(item => ({
          ...item, viewer_reaction: null, viewer_saved: false, selected_list_ids: [],
          ...byId.get(String(item.repo_id)),
        }));
        const body = JSON.stringify(payload);
        response = { body, etag: `"${createHash('sha256').update(body).digest('hex')}"` };
      }
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

export const listTrending = createTrendingHandler(new TrendingSnapshotService(trendingSnapshotSource), loadTrendingViewerState);
