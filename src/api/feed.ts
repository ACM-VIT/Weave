import { apiV2Raw } from './client';
import { createUuid, getAppSessionId } from '../utils/uuid';

type FeedItemV2 = {
  repo_id: string;
  position: number;
  repository: Record<string, unknown>;
};

type FeedResponseV2 = {
  serve_id: string;
  feed_version: string;
  items: FeedItemV2[];
  next_cursor: string | null;
};

export async function fetchFeed(token: string, cursor: string | null = null) {
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
