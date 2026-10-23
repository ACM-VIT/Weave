import type { ListDto } from '../models/list';
import type { ProfileRepositoryPage } from './profile-data';

type SectionLoaders = {
  boards: (signal: AbortSignal) => Promise<ListDto[]>;
  collections: (signal: AbortSignal) => Promise<ListDto[]>;
};

/** Saves affect both independently cached List sources for the current viewer. */
export function profileContentInvalidationFilters(viewer: string | undefined) {
  return { queryKey: ['profile-content', viewer] as const, exact: false };
}

/** Retain the mutation invalidation prefix and partition every section by viewer. */
export function profileSectionQueries(viewer: string | undefined, loaders: SectionLoaders) {
  const key = (section: string) => ['profile-content', viewer, section] as const;
  return {
    boards: {
      queryKey: key('boards'), enabled: Boolean(viewer), staleTime: 60_000,
      queryFn: ({ signal }: { signal: AbortSignal }) => loaders.boards(signal),
    },
    collections: {
      queryKey: key('collections'), enabled: Boolean(viewer), staleTime: 60_000,
      queryFn: ({ signal }: { signal: AbortSignal }) => loaders.collections(signal),
    },
  };
}

export function profileRepositoryQuery(
  viewer: string | undefined,
  type: 'likes' | 'saved',
  active: boolean,
  load: (offset: number, signal: AbortSignal) => Promise<ProfileRepositoryPage>,
) {
  return {
    queryKey: ['profile-stat-repositories', type, viewer] as const,
    enabled: Boolean(viewer) && active,
    staleTime: 30_000,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }: { pageParam: number; signal: AbortSignal }) => load(pageParam, signal),
    getNextPageParam: (last: ProfileRepositoryPage) => last.nextOffset,
  };
}
