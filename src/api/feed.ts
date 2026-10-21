import { apiV2Raw } from './client';
import { createUuid, getAppSessionId } from '../utils/uuid';
import { requestFeedWithRetry } from '../services/feedTransport';
import type { FeedPage } from '../services/feedPagination';

type FeedResponseV2 = {
  serve_id: string;
  feed_version: string;
  items: { repo_id: string; position: number; repository: Record<string, unknown> }[];
  next_cursor: string | null;
};

export async function fetchFeed(
  token: string,
  cursor: string | null = null,
  options: { signal?: AbortSignal; requestId?: string; sessionId?: string } = {},
): Promise<FeedPage> {
  const body = {
    feed_request_id: options.requestId ?? createUuid(),
    session_id: options.sessionId ?? getAppSessionId(),
    limit: 10,
    cursor,
  };
  const data = await requestFeedWithRetry(body, async (request, signal) => {
    const result = await apiV2Raw<FeedResponseV2>('/feed', {
      method: 'POST', body: JSON.stringify(request), signal,
    }, token);
    return result.data;
  }, options.signal);
  return {
    items: data.items.map((item) => ({
      ...item.repository, repo_id: item.repo_id, position: item.position,
      serve_id: data.serve_id, feed_version: data.feed_version,
    })),
    nextCursor: data.next_cursor,
    feedVersion: data.feed_version,
    sessionId: body.session_id,
  };
}
