import { apiV2 } from './client';
import { fetchFeed, type FeedPage } from './feed';
import type { RepositoryApiPayload } from './repositories';
import { loadHomeFeedPage } from '../utils/home-feed';

export function fetchHomeFeed(token: string, cursor: string | null, options: Parameters<typeof fetchFeed>[2] = {}): Promise<FeedPage> {
  return loadHomeFeedPage(cursor, {
    personalized: (pageCursor) => fetchFeed(token, pageCursor, { ...options, retryUnavailable: false }),
    discovery: async (offset, limit) => {
      const page = await apiV2<{ items: RepositoryApiPayload[] }>(`/repositories?limit=${limit}&offset=${offset}`, { signal: options.signal }, token);
      if (!Array.isArray(page.items)) throw new Error('The repository catalogue response was incomplete.');
      return page.items;
    },
  }).then(page => ({...page, sessionId: options.sessionId ?? page.sessionId}));
}
