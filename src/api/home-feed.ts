import { measureFeedLoad } from '../services/feedTiming';
import { fetchFeed, type FeedPage } from './feed';
import { loadHomeFeedPage } from '../utils/home-feed';

export function fetchHomeFeed(token: string, cursor: string | null,
  options: Parameters<typeof fetchFeed>[2] & { initialPage?: boolean } = {}): Promise<FeedPage> {
  const { initialPage = false, ...transportOptions } = options;
  return measureFeedLoad(async () => {
    const page = await loadHomeFeedPage(cursor, {
      // Reuse the same request/session identity across the existing bounded retries.
      personalized: (pageCursor) => fetchFeed(token, pageCursor, { ...transportOptions, retryUnavailable: true, preparationRetryLimit: 1 }),
    });
    return { ...page, sessionId: page.sessionId ?? options.sessionId };
  }, initialPage);
}
