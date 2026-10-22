import type { ListDto } from '../models/list';

type SectionLoaders = {
  boards: (signal: AbortSignal) => Promise<ListDto[]>;
  collections: (signal: AbortSignal) => Promise<ListDto[]>;
};

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
