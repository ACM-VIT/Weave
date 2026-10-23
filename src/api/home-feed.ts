import { measureFeedLoad } from '../services/feedTiming';
import { apiV2Raw } from './client';
import { fetchFeed, type FeedPage } from './feed';
import type { RepositoryApiPayload } from './repositories';
import { loadHomeFeedPage } from '../utils/home-feed';

export function fetchHomeFeed(token: string, cursor: string | null,
  options: Parameters<typeof fetchFeed>[2] & { initialPage?: boolean } = {}): Promise<FeedPage> {
  const { initialPage = false, ...transportOptions } = options;
  return measureFeedLoad(async () => {
    let catalogueTraceparent: string | undefined;
    const page = await loadHomeFeedPage(cursor, {
      personalized: (pageCursor) => fetchFeed(token, pageCursor, { ...transportOptions, retryUnavailable: false }),
      discovery: async (offset, limit) => {
        const result = await apiV2Raw<{ data: { items: RepositoryApiPayload[] } }>(
          `/repositories?limit=${limit}&offset=${offset}`, { signal: options.signal }, token);
        if (!Array.isArray(result.data?.data?.items)) throw new Error('The repository catalogue response was incomplete.');
        catalogueTraceparent = result.response.headers.get('traceparent') ?? undefined;
        return result.data.data.items;
      },
    });
    return { ...page, sessionId: options.sessionId ?? page.sessionId,
      ...(catalogueTraceparent ? { serverTraceparent: catalogueTraceparent } : {}) };
  }, initialPage);
}
