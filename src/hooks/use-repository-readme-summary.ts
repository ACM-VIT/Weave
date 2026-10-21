import { useQuery } from '@tanstack/react-query';
import { fetchRepositoryReadmeSummary, type RepositoryReadmeSummary } from '@/api/repositories';
import { resolveReadmeDigest, type ReadmeDigest } from '@/models/readme-digest';
import { useAuth } from '@/store/AuthContext';
import { getStorageItem } from '@/utils/storage';

/** Refresh one active card's artifact independently; never invalidate or remount the feed. */
export function useRepositoryReadmeSummary(repository: { id: string; readmeDigest?: ReadmeDigest | null } | undefined, active = true) {
  const { user }=useAuth();
  const query=useQuery<RepositoryReadmeSummary>({
    queryKey:['readme-summary',user?.user_id,repository?.id],
    enabled: Boolean(active && repository?.id && user?.user_id),
    initialData: repository?.readmeDigest ? { status:'ready',content_version:repository.readmeDigest.content_version,summary:repository.readmeDigest } : undefined,
    staleTime:60000,retry:1,
    refetchInterval:(state)=>active && ['pending','processing'].includes(state.state.data?.status??'') ? 5000 : false,
    queryFn:async({signal})=>{
      const token=await getStorageItem('access_token');
      if(!token || !repository?.id)throw new Error('Sign in to read repository summaries.');
      return fetchRepositoryReadmeSummary(repository.id,token,signal);
    },
  });
  return {...query,digest:resolveReadmeDigest(repository?.readmeDigest,query.data)};
}
