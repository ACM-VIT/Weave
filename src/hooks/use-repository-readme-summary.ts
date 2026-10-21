import { useQuery } from '@tanstack/react-query';
import { fetchRepositoryReadmeSummary, type RepositoryReadmeSummary } from '@/api/repositories';
import { readmeSummaryQueryKey, resolveReadmeDigest, type ReadmeDigest } from '@/models/readme-digest';
import { useAuth } from '@/store/AuthContext';
import { getStorageItem } from '@/utils/storage';

/** Refresh one active card's artifact independently; never invalidate or remount the feed. */
export function useRepositoryReadmeSummary(
  repository: { id: string; contentVersion?: number | null; readmeDigest?: ReadmeDigest | null } | undefined,
  active = true,
) {
  const { user } = useAuth();
  const initialDigest = resolveReadmeDigest(repository?.readmeDigest, undefined, repository?.contentVersion);
  const query = useQuery<RepositoryReadmeSummary>({
    queryKey: readmeSummaryQueryKey(user?.user_id, repository?.id, repository?.contentVersion),
    enabled: Boolean(active && repository?.id && user?.user_id),
    initialData: initialDigest
      ? { status: 'ready', content_version: initialDigest.content_version, summary: initialDigest }
      : undefined,
    staleTime: 60_000,
    retry: 1,
    refetchInterval: state => active && ['pending', 'processing'].includes(state.state.data?.status ?? '') ? 5000 : false,
    queryFn: async ({ signal }) => {
      const token = await getStorageItem('access_token');
      if (!token || !repository?.id) throw new Error('Sign in to read repository summaries.');
      return fetchRepositoryReadmeSummary(repository.id, token, signal);
    },
  });
  return { ...query, digest: resolveReadmeDigest(initialDigest, query.data, repository?.contentVersion) };
}
