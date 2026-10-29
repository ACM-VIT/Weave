import type { QueryClient } from '@tanstack/react-query';
import type { RepositoryDetail } from '../models/repository';

const prefix = 'repository-preview';
export const repositoryPreviewQueryKey = (viewer: string | undefined, id: string) => [prefix, viewer, id] as const;

/** A presentation hint, never a complete/fresh detail response or feed attribution. */
export function rememberRepositoryPreview(client: QueryClient, viewer: string | undefined, repository: RepositoryDetail) {
  if (!viewer || repository.status !== 'active') return;
  const key = repositoryPreviewQueryKey(viewer, repository.id);
  client.setQueryDefaults([prefix, viewer], { gcTime: 5 * 60_000 });
  client.setQueryData<RepositoryDetail>(key, {
    ...repository, readmeFull: null, serveId: null, feedPosition: null,
    feedSessionId: null, originalImpression: null,
  });
  const entries = client.getQueryCache().findAll({ queryKey: [prefix, viewer] })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  for (const entry of entries.slice(100)) client.removeQueries({ queryKey: entry.queryKey, exact: true });
}

export function repositoryPreview(client: QueryClient, viewer: string | undefined, id: string) {
  if (!viewer) return undefined;
  const key = repositoryPreviewQueryKey(viewer, id);
  const state = client.getQueryState<RepositoryDetail>(key);
  return state && Date.now() - state.dataUpdatedAt < 5 * 60_000 ? state.data : undefined;
}
