import { useQuery } from '@tanstack/react-query';
import { fetchRepositoryDetail, repositoryDetailQueryKey } from '@/api/repositories';
import { authSessionLifecycle } from '@/api/session-lifecycle';
import type { RepositoryData } from '@/data/repositories';
import { useAuth } from '@/store/AuthContext';
import { getStorageItem } from '@/utils/storage';
import { ReadmePopup } from './ReadmePopup';

/** Mounted only when the viewer opens the original README from a feed row. */
export function FeedReadmePopup({ repository, onClose }: {
  repository: RepositoryData;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const generation = authSessionLifecycle.currentGeneration();
  const query = useQuery({
    queryKey: repositoryDetailQueryKey(repository.id, user?.user_id),
    enabled: Boolean(user?.user_id && !repository.readmeFull),
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      authSessionLifecycle.assertCurrent(generation);
      const token = await getStorageItem('access_token');
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      authSessionLifecycle.assertCurrent(generation);
      const result = await fetchRepositoryDetail(repository.id, token, signal);
      authSessionLifecycle.assertCurrent(generation);
      return result;
    },
  });
  const source = repository.readmeFull ? repository : query.data ?? repository;
  return <ReadmePopup isVisible onClose={onClose} title={repository.name} contentKind="readme"
    readmeText={source.readmeFull} loading={!repository.readmeFull && query.isPending}
    errorMessage={!repository.readmeFull && query.error instanceof Error ? query.error.message : null}
    onRetry={() => void query.refetch()} readmeSource={{ fullName: source.fullName, githubUrl: source.githubUrl,
      readmeBaseUrl: source.readmeBaseUrl, readmeDefaultBranch: source.readmeDefaultBranch,
      readmeSourcePath: source.readmeSourcePath }} />;
}
