import type { QueryClient } from '@tanstack/react-query';
import type { FeedPage } from '../api/feed';
import type { RepositoryApiPayload } from '../api/repositories';

type HomeFeedReaders = {
  personalized: (cursor: string | null) => Promise<FeedPage>;
  discovery?: (offset: number, limit: number) => Promise<RepositoryApiPayload[]>;
};

/** Home retains recommendation semantics when generation outlives one HTTP wait. */
export async function loadHomeFeedPage(cursor: string | null, readers: HomeFeedReaders): Promise<FeedPage> {
  if (cursor?.startsWith('discovery:')) {
    throw Object.assign(new Error('The repository page has expired. Refresh Home to start again.'),
      { status: 400, code: 'FEED_CURSOR_STALE' });
  }
  return { ...await readers.personalized(cursor), mode: 'personalized' };
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
