import { apiV2Raw } from './client';
import { createUuid, getAppSessionId } from '../utils/uuid';

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
  // Active generated README-derived summary for the larger feed card.
  summary: string | null;
  readme_md: string | null;
  updated_at: string | null;
  viewer_reaction: 'like' | 'dislike' | null;
  viewer_saved: boolean;
  viewer_follows_owner: boolean;
  position: number;
  serve_id: string;
  feed_version: string;
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

type FeedItemV2 = {
  repo_id: string;
  position: number;
  repository: Omit<FeedRepositoryPayload, 'feed_version' | 'position' | 'repo_id' | 'serve_id'>;
};

type FeedResponseV2 = {
  serve_id: string;
  feed_version: string;
  items: FeedItemV2[];
  next_cursor: string | null;
};

export type FeedPage = {
  items: FeedRepositoryPayload[];
  nextCursor: string | null;
};

export async function fetchFeed(
  token: string,
  cursor: string | null = null,
): Promise<FeedPage> {
  const feedRequestId = createUuid();
  const body = {
    feed_request_id: feedRequestId,
    session_id: getAppSessionId(),
    limit: 10,
    cursor,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await apiV2Raw<FeedResponseV2>('/feed', {
        method: 'POST',
        body: JSON.stringify(body),
      }, token);
      return {
        items: data.items.map((item) => ({
          ...item.repository,
          repo_id: item.repo_id,
          position: item.position,
          serve_id: data.serve_id,
          feed_version: data.feed_version,
        })),
        nextCursor: data.next_cursor,
      };
    } catch (error) {
      const failure = error as {
        status?: number;
        code?: string;
        retryable?: boolean;
        retryAfter?: string;
      };
      const shouldRetry = failure.status === 409
        || (failure.status === 503
          && failure.code === 'PERSONALIZED_FEED_UNAVAILABLE'
          && failure.retryable === true);
      if (!shouldRetry || attempt === 2) throw error;
      const retryAfter = Number((error as { retryAfter?: string }).retryAfter ?? 1);
      const exponentialDelay = 1_000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(5_000, Math.max(100, retryAfter * 1_000, exponentialDelay)),
      ));
    }
  }
  throw new Error('Feed retry loop completed without a response.');
}
