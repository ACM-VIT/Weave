import type { QueryClient } from '@tanstack/react-query';

export function listRepositoryQueryKey(kind: 'board' | 'collection' | 'pinned', viewer: string | undefined, id: string) {
  return [`${kind === 'pinned' ? 'pinned' : kind}-repositories`, viewer, id] as const;
}

/** Cancel first, then remove synchronously so late responses cannot restore another account's data. */
export function clearAccountQueryCache(client: QueryClient): void {
  void client.cancelQueries();
  client.clear();
}
