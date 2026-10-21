import type { QueryClient } from '@tanstack/react-query';
import type { FeedPage } from '../api/feed';
import type { RepositoryApiPayload } from '../api/repositories';

export const DISCOVERY_PAGE_SIZE = 10;
const DISCOVERY_CURSOR = /^discovery:(0|[1-9]\d{0,5})$/;

type HomeFeedReaders = {
  personalized: (cursor: string | null) => Promise<FeedPage>;
  discovery: (offset: number, limit: number) => Promise<RepositoryApiPayload[]>;
};

/** Browse the canonical catalogue only after an explicit first-page ML failure. */
export async function loadHomeFeedPage(cursor: string | null, readers: HomeFeedReaders): Promise<FeedPage> {
  let offset = 0;
  if (cursor?.startsWith('discovery:')) {
    const match = DISCOVERY_CURSOR.exec(cursor);
    if (!match) throw new Error('The repository page has expired. Refresh Home to start again.');
    offset = Number(match[1]);
  } else {
    try {
      return { ...await readers.personalized(cursor), mode: 'personalized' };
    } catch (error) {
      const failure = error as { status?: number; code?: string };
      if (cursor !== null || failure.status !== 503 || failure.code !== 'PERSONALIZED_FEED_UNAVAILABLE') throw error;
    }
  }
  const items = await readers.discovery(offset, DISCOVERY_PAGE_SIZE);
  // Catalogue entries have no recommendation serve/position attribution.
  const canonicalItems = items.map(({ serve_id: _serve, position: _position, feed_version: _version, ...item }) => item);
  return {
    mode: 'discovery', items: canonicalItems,
    nextCursor: items.length === DISCOVERY_PAGE_SIZE ? `discovery:${offset + DISCOVERY_PAGE_SIZE}` : null,
  };
}

/** Offset pages may overlap when ingestion updates the catalogue during browsing. */
export function homeFeedItems(pages: FeedPage[]): RepositoryApiPayload[] {
  const seen = new Set<unknown>();
  return pages.flatMap((page) => page.items.filter((item) => {
    if (page.mode !== 'discovery') return true;
    if (seen.has(item.repo_id)) return false;
    seen.add(item.repo_id);
    return true;
  }));
}

export function canContinueHomeFeed(mode: FeedPage['mode'], invalidationGeneration: number): boolean {
  return mode === 'discovery' || invalidationGeneration === 0;
}

/** Direct follows invalidate the query without refetching/remounting loaded cards. */
export function subscribeToHomeFeedInvalidations(
  client: QueryClient,
  key: readonly unknown[],
  onInvalidated: () => void,
): () => void {
  return client.getQueryCache().subscribe(event => {
    if (event.type === 'updated' && event.action.type === 'invalidate'
      && event.query.queryKey.length === key.length
      && event.query.queryKey.every((value: unknown, index: number) => value === key[index])) onInvalidated();
  });
}
