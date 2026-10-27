import type { RecommendationSource } from '../models/recommendation';
import { decodeFeedPage, type FeedResponseV2 } from './feed-data';
import { apiV2Raw } from './client';
import { createUuid, getAppSessionId } from '../utils/uuid';
import { requestFeedWithRetry } from '../services/feedTransport';
import type { FeedPage } from '../services/feedPagination';
export type { FeedPage } from '../services/feedPagination';

export type FeedRepositoryPayload = {
  repo_id: string;
  full_name: string;
  owner_user_id: string | null;
  owner_profile_id: string | null;
  owner_profile_claimed_user_id: string | null;
  owner_bio: string | null;
  // Short repository subtitle displayed below the repository name.
  description: string | null;
  languages: string[];
  star_count: number;
  fork_count: number;
  likes_count: number;
  comments_count: number;
  views_count: number;
  open_issues_count: number;
  // Active concise V2 summary artifact for the larger feed card.
  summary: string | null;
  readme_md?: string | null;
  readme_media_manifest?: unknown;
  readme_available?: boolean;
  content_version?: number | null;
  content_hash?: string | null;
  readme_digest?: unknown;
  readme_source_path?: string | null;
  readme_default_branch?: string | null;
  readme_base_url?: string | null;
  summary_highlights?: string[];
  summary_prompt_version?: string | null;
  summary_model_version?: string | null;
  summary_format_version?: string | null;
  summary_source?: 'generated' | 'description_fallback' | null;
  updated_at: string | null;
  viewer_reaction: 'like' | 'dislike' | null;
  viewer_saved: boolean;
  viewer_follows_owner: boolean;
  position: number;
  serve_id: string;
  feed_version: string;
  recommendation_source?: RecommendationSource;
  // Legacy aliases may accompany a V2 payload during rollout. They stay
  // distinct so complete README content can never be mistaken for a summary.
  github_repo?: string;
  url?: string;
  html_url?: string;
  language_used?: string[] | Record<string, unknown>;
  readme_summary?: string | null;
  readme?: string | null;
  owner_profile?: { bio?: string | null } | null;
  pr_count?: number;
  saves_count?: number;
  comment_count?: number;
};

export async function fetchFeed(
  token: string,
  cursor: string | null = null,
  options: { signal?: AbortSignal; requestId?: string; sessionId?: string; retryUnavailable?: boolean } = {},
): Promise<FeedPage> {
  const body = {
    feed_request_id: options.requestId ?? createUuid(),
    session_id: options.sessionId ?? getAppSessionId(),
    limit: 10,
    cursor,
    readme_mode: 'deferred' as const,
  };
  const data = await requestFeedWithRetry(body, async (request, signal) => {
    const result = await apiV2Raw<FeedResponseV2>('/feed', {
      method: 'POST', body: JSON.stringify(request), signal,
    }, token);
    return { data: result.data, traceparent: result.response.headers.get('traceparent') };
  }, options.signal, undefined, options.retryUnavailable);
  return { ...decodeFeedPage(data.data, body.session_id), serverTraceparent: data.traceparent ?? undefined };
}
