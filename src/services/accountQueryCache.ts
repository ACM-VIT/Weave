import type { QueryClient } from '@tanstack/react-query';

export function listRepositoryQueryKey(kind: 'board' | 'collection' | 'pinned', viewer: string | undefined, id: string) {
  return [`${kind === 'pinned' ? 'pinned' : kind}-repositories`, viewer, id] as const;
}

/** Cancel first, then remove synchronously so late responses cannot restore another account's data. */
export function clearAccountQueryCache(client: QueryClient): void {
  void client.cancelQueries();
  client.clear();
}

/** Page List contents while keeping mutation invalidations on their existing prefix. */
export function listRepositoryQueryOptions<T>(
  kind: 'board' | 'collection' | 'pinned', viewer: string | undefined, id: string,
  load: (cursor: string | null, signal: AbortSignal) => Promise<{items:T[];has_more:boolean;next_cursor:string|null}>,
) {
  return {
    queryKey: [...listRepositoryQueryKey(kind, viewer, id), 'keyset-v1'] as const,
    enabled: Boolean(viewer && (kind === 'pinned' || id)),
    initialPageParam: null as string | null,
    queryFn: ({pageParam,signal}: {pageParam:string|null;signal:AbortSignal}) => load(pageParam,signal),
    getNextPageParam: (page: {next_cursor:string|null}) => page.next_cursor ?? undefined,
    staleTime: 30_000,
    retry: false as const,
  };
}
