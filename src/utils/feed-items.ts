import type { RepositoryData } from '../data/repositories';
import { getFeedItemIdentity, mapFeedRepository } from './feed-repository';

// Reuse the canonical V2 mapper so short summaries, README digests and real
// engagement counts remain consistent across discovery and personalized feeds.
export const mapBackendToFrontend = mapFeedRepository;

export type FeedItem = { feedId: string; repository: RepositoryData };
export type FeedPage = { items: readonly Record<string, any>[]; mode?: 'personalized' | 'discovery' };

// React Query pages/items are immutable and structurally shared. Weak caches do
// not retain discarded query histories or share viewer projections across users.
export function createFeedItemMapper(mapRepository = mapBackendToFrontend) {
  const repositories = new WeakMap<object, RepositoryData | null>();
  const pages = new WeakMap<FeedPage['items'], readonly RepositoryData[]>();
  let previous: FeedItem[] = [];

  return (sourcePages: readonly FeedPage[] | undefined): FeedItem[] => {
    const next: FeedItem[] = [];
    const discoveryIds = new Set<string>();
    for (const page of sourcePages ?? []) {
      let mappedPage = pages.get(page.items);
      if (!mappedPage) {
        const mapped: RepositoryData[] = [];
        for (const source of page.items) {
          let repository = repositories.get(source);
          if (repository === undefined) {
            repository = mapRepository(source);
            repositories.set(source, repository);
          }
          if (repository) mapped.push(repository);
        }
        mappedPage = mapped;
        pages.set(page.items, mappedPage);
      }
      for (const repository of mappedPage) {
        if (page.mode === 'discovery') {
          if (discoveryIds.has(repository.id)) continue;
          discoveryIds.add(repository.id);
        }
        const index = next.length;
        const retained = previous[index];
        next.push(retained?.repository === repository ? retained : {
          feedId: getFeedItemIdentity(repository, index),
          repository,
        });
      }
    }
    if (previous.length !== next.length || next.some((entry, index) => entry !== previous[index])) {
      previous = next;
    }
    return previous;
  };
}
