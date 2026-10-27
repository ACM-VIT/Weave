import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readmeSummaryProjection } from '../services/readmeSummaryService.js';
import type { Response } from 'express';
import { sqlClient } from '../db/index.js';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import {
  TrendingSnapshotService,
  TrendingUnavailableError,
  TRENDING_QUERY_TIMEOUT_MS,
  TRENDING_FRESHNESS_MS,
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
        c.description,c.primary_language,c.languages,c.language_breakdown,c.language_total_size::float8 AS language_total_size,c.language_breakdown_complete,to_char(c.language_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS language_observed_at,c.content_version,
        ${tx.unsafe(readmeSummaryProjection('r','c'))},
        c.readme_source_path AS readme_source_path,
        c.readme_default_branch AS readme_default_branch,
        c.readme_base_url AS readme_base_url,c.updated_at AS content_updated_at,c.source_updated_at,
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

export interface TrendingViewerState {
  repo_id: string;
  viewer_reaction: 'like' | 'dislike' | null;
  viewer_saved: boolean;
  selected_list_ids: string[];
}

export interface TrendingRequestBudget {
  check(): void;
  remainingMs(): number;
}

export type TrendingViewerLoader = (
  viewerId: string, repositoryIds: string[], budget?: TrendingRequestBudget,
) => Promise<readonly TrendingViewerState[]>;

export const TRENDING_VIEWER_HYDRATION_LIMIT = 3;

/** Private state is read on every request, never stored in the shared cache. */
export function createTrendingViewerLoader(client: typeof sqlClient = sqlClient): TrendingViewerLoader {
  return async (viewerId, repositoryIds, budget) => {
    if (!repositoryIds.length) return [];
    return client.begin(async tx => {
      // BEGIN may have waited for a pooled connection beyond the HTTP deadline.
      // Do not start an obsolete SELECT; throwing still waits for rollback.
      budget?.check();
      const remaining = budget?.remainingMs() ?? TRENDING_QUERY_TIMEOUT_MS;
      if (remaining < 1) throw new TrendingUnavailableError();
      const queryTimeout = Math.min(TRENDING_QUERY_TIMEOUT_MS, Math.floor(remaining));
      await tx`SELECT set_config('statement_timeout', ${String(queryTimeout)}, true)`;
      budget?.check();
      return tx<TrendingViewerState[]>`
        SELECT repository.repo_id,reaction.reaction AS viewer_reaction,
          (saved.repo_id IS NOT NULL) AS viewer_saved,
          COALESCE((SELECT json_agg(selection.list_id ORDER BY selection.list_id) FROM (
            SELECT 'collection:' || collection.collection_id::text AS list_id
            FROM app.collection_repos membership JOIN app.board_collections collection USING(collection_id)
            WHERE membership.repo_id=repository.repo_id AND collection.user_id=${viewerId}::uuid
            UNION ALL
            SELECT 'legacy-board:' || board.board_id::text AS list_id
            FROM app.board_repos membership JOIN app.boards board USING(board_id)
            WHERE membership.repo_id=repository.repo_id AND board.user_id=${viewerId}::uuid
          ) selection),'[]'::json) AS selected_list_ids
        FROM app.repos repository
        LEFT JOIN app.reactions reaction
          ON reaction.repo_id=repository.repo_id AND reaction.user_id=${viewerId}::uuid
        LEFT JOIN app.saves saved
          ON saved.repo_id=repository.repo_id AND saved.user_id=${viewerId}::uuid
        WHERE repository.repo_id=ANY(${repositoryIds}::uuid[])
      `;
    });
  };
}

export type TrendingViewerStateLoader = TrendingViewerLoader;
export const loadTrendingViewerState = createTrendingViewerLoader();

export function createTrendingHandler(
  service: TrendingSnapshotService,
  loadViewer: TrendingViewerLoader = loadTrendingViewerState,
  now: () => number = () => performance.now(),
) {
  let viewerHydrations = 0;
  return async (req: AuthRequest, res: Response): Promise<void> => {
    const expiresAt = now() + TRENDING_FRESHNESS_MS;
    const viewerId = req.user?.userId;
    if (!viewerId) return sendError(res, 401, 'Authentication required.');
    if (req.query.period !== undefined
      && (typeof req.query.period !== 'string' || !['daily', 'weekly', 'monthly'].includes(req.query.period))) {
      return sendError(res, 400, 'Invalid trending period.');
    }
    let expired = false;
    const budget: TrendingRequestBudget = {
      remainingMs: () => expiresAt - now(),
      check() {
        if (expired || now() >= expiresAt) throw new TrendingUnavailableError();
      },
    };
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new TrendingUnavailableError());
      }, Math.max(0, budget.remainingMs()));
    });
    // The caller may time out, but this work promise continues owning any
    // admitted database slot until BEGIN/projection/commit or rollback settles.
    const work = Promise.resolve().then(async () => {
      budget.check();
      const hydrateViewer = async (ids: readonly string[]) => {
        budget.check();
        if (viewerHydrations >= TRENDING_VIEWER_HYDRATION_LIMIT) throw new TrendingUnavailableError();
        viewerHydrations++;
        try { return await loadViewer(viewerId,[...ids],budget); }
        finally { viewerHydrations--; }
      };
      const cachedIds = service.cachedRepositoryIds(req.query.period as TrendingPeriod | undefined);
      // Catch immediately: a public-cache failure must not leave an unhandled private query.
      const early = cachedIds?.length ? hydrateViewer(cachedIds)
        .then(rows=>({rows,error:undefined}),error=>({rows:undefined,error})) : undefined;
      const [response, earlyResult] = await Promise.all([
        service.get(req.query.period as TrendingPeriod | undefined), early,
      ]);
      budget.check();
      // Parsing creates request-owned objects; overlaying a viewer's state can
      // never mutate the process-shared public snapshot or another request.
      const payload = JSON.parse(response.body) as {
        success: true;
        data: { items: Record<string, unknown>[] };
      };
      budget.check();
      const repositoryIds = payload.data.items.map(item => String(item.repo_id));
      budget.check();
      let viewerRows: readonly TrendingViewerState[] = [];
      if (repositoryIds.length) {
        const sameMembership = cachedIds?.length === repositoryIds.length
          && repositoryIds.every(id=>cachedIds.includes(id));
        if (sameMembership && earlyResult) {
          if (earlyResult.error) throw earlyResult.error;
          viewerRows = earlyResult.rows ?? [];
        } else viewerRows = await hydrateViewer(repositoryIds);
        budget.check();
      }
      const byId = new Map(viewerRows.map(row => [row.repo_id, row]));
      budget.check();
      payload.data.items = payload.data.items.map(item => {
        const state = byId.get(String(item.repo_id));
        return {
          ...item,
          viewer_reaction: state?.viewer_reaction ?? null,
          viewer_saved: state?.viewer_saved ?? false,
          selected_list_ids: state?.selected_list_ids ?? [],
        };
      });
      budget.check();
      const body = JSON.stringify(payload);
      budget.check();
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
      budget.check();
      return { body, etag };
    });
    try {
      const response = await Promise.race([work, deadline]);
      budget.check();
      // Conditional requests still hydrate the authenticated viewer first.
      // The final validator covers private state and the public snapshot.
      res.set('Cache-Control', 'private, no-cache');
      res.vary('Authorization');
      res.set('ETag', response.etag);
      budget.check();
      res.status(200).type('json').send(response.body);
    } catch (error) {
      if (error instanceof TrendingUnavailableError
        || (error instanceof Error && 'code' in error && error.code === '57014')) {
        res.removeHeader('ETag');
        res.set('Cache-Control', 'no-store');
        res.set('Retry-After', '1');
        return sendError(res, 503, new TrendingUnavailableError().message);
      }
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  };
}

export const listTrending = createTrendingHandler(new TrendingSnapshotService(trendingSnapshotSource));
