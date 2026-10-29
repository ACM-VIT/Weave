import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getRepositoryLists, repositoryListsQueryKey } from '@/api/lists';
import { authSessionLifecycle } from '@/api/session-lifecycle';
import { getItemAsync } from '@/utils/storage';

/** Complete, account-scoped membership data shared by warmup and the picker. */
export function repositoryListsQueryOptions(repoId: string | undefined, viewer: string | undefined) {
  const generation = authSessionLifecycle.currentGeneration();
  return {
    queryKey: repositoryListsQueryKey(repoId, viewer),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      authSessionLifecycle.assertCurrent(generation);
      if (!repoId || !viewer) throw new Error('Sign in to manage repository Lists.');
      const token = await getItemAsync('access_token');
      authSessionLifecycle.assertCurrent(generation);
      if (!token) throw new Error('Sign in to manage repository Lists.');
      const lists = await getRepositoryLists(repoId, token, signal);
      authSessionLifecycle.assertCurrent(generation);
      return lists;
    },
    staleTime: 30_000,
    gcTime: 60_000,
  };
}

/** Ignore quick swipes and offscreen rows; never cancel a sheet-owned request. */
export function usePrefetchRepositoryLists(repoId: string, viewer: string | undefined, active: boolean) {
  const client = useQueryClient();
  const generation = authSessionLifecycle.currentGeneration();
  useEffect(() => {
    if (!active || !viewer) return;
    const options = repositoryListsQueryOptions(repoId, viewer);
    const timer = setTimeout(() => {
      if (authSessionLifecycle.isCurrent(generation)) {
        void client.prefetchQuery({ ...options, retry: false });
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      const query = client.getQueryCache().find({ queryKey: options.queryKey, exact: true });
      if (query?.getObserversCount() === 0) void client.cancelQueries({ queryKey: options.queryKey, exact: true });
    };
  }, [active, client, generation, repoId, viewer]);
}
