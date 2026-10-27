import { useLayoutEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchRepositoryMetadata, fetchRepositoryReadme } from '@/api/repositories';
import { authSessionLifecycle } from '@/api/session-lifecycle';
import { repositoryDetailQueryKey, repositoryMetadataQueryKey, repositoryReadmeMetadataQueryKey, repositoryReadmeQueryKey, type RepositoryDetail, type RepositoryReadmeDocument, type RepositoryReadmeMetadata } from '@/models/repository';
import { useAuth } from '@/store/AuthContext';
import { getStorageItem } from '@/utils/storage';

function identified(repository: Pick<RepositoryDetail,'contentVersion'|'contentHash'> | undefined): repository is {contentVersion:number;contentHash:string} {
  return Boolean(repository && Number.isInteger(repository.contentVersion) && repository.contentVersion! > 0 && repository.contentHash);
}

function readmeMetadata(repository: RepositoryDetail): RepositoryReadmeMetadata {
  return {id:repository.id,fullName:repository.fullName,githubUrl:repository.githubUrl,
    contentVersion:repository.contentVersion,contentHash:repository.contentHash,hasReadme:repository.hasReadme,
    readmeSourcePath:repository.readmeSourcePath,readmeDefaultBranch:repository.readmeDefaultBranch,readmeBaseUrl:repository.readmeBaseUrl};
}

/** One immutable document cache shared by original README and summary media. No viewer-state writes. */
export function useRepositoryReadme(repository: RepositoryDetail | undefined, active: boolean) {
  const {user} = useAuth();
  const viewer = user?.user_id;
  const client = useQueryClient();
  const generation = authSessionLifecycle.currentGeneration();
  const scope = `${viewer ?? ''}:${repository?.id ?? ''}:${generation}`;
  const refresh = useRef({scope, used:false});
  useLayoutEffect(() => { refresh.current = {scope,used:false}; }, [active,scope]);
  const token = async () => {
    authSessionLifecycle.assertCurrent(generation);
    const value = await getStorageItem('access_token');
    authSessionLifecycle.assertCurrent(generation);
    if (!value) throw new Error('Your session has expired. Please sign in again.');
    return value;
  };
  const loadMetadata = async (signal?: AbortSignal) => {
    const value = await fetchRepositoryMetadata(repository!.id, await token(), signal);
    authSessionLifecycle.assertCurrent(generation);
    return value;
  };
  const metadataKey = repositoryReadmeMetadataQueryKey(repository?.id ?? '',viewer);
  const existingMetadataKey = repositoryMetadataQueryKey(repository?.id ?? '',viewer);
  const metadata = useQuery<RepositoryReadmeMetadata>({queryKey:metadataKey,
    enabled:Boolean(active && viewer && repository && !identified(repository) && !repository.readmeFull),
    queryFn:async({signal})=>readmeMetadata(await loadMetadata(signal)),staleTime:60_000,retry:false,
    initialData:()=>{
      authSessionLifecycle.assertCurrent(generation);
      const current=client.getQueryData<RepositoryDetail>(existingMetadataKey);
      return current && current.id===repository?.id ? readmeMetadata(current) : undefined;
    }});
  // A version-conflict refresh uses an identity-only cache, never the viewer-state cache.
  const refreshed = metadata.data && repository && (!identified(repository) || (metadata.data.contentVersion ?? 0) > repository.contentVersion)
    ? {...repository,...metadata.data,readmeFull:null} : repository;
  const source = refreshed;
  const identity = identified(source) ? source : undefined;
  const inline = source?.readmeFull ? source : undefined;
  const document = useQuery<RepositoryReadmeDocument>({
    queryKey:repositoryReadmeQueryKey(repository?.id ?? '',viewer,identity?.contentVersion),
    enabled:Boolean(active && viewer && identity && !inline),staleTime:Infinity,retry:false,
    initialData:() => {
      authSessionLifecycle.assertCurrent(generation);
      if (!identity) return undefined;
      const full = inline ?? client.getQueryData<RepositoryDetail>(repositoryDetailQueryKey(identity.id,viewer));
      return full?.readmeFull && full.contentVersion === identity.contentVersion && full.contentHash === identity.contentHash
        ? {id:full.id,fullName:full.fullName,githubUrl:full.githubUrl,readmeFull:full.readmeFull,
          readmeSourcePath:full.readmeSourcePath,readmeDefaultBranch:full.readmeDefaultBranch,readmeBaseUrl:full.readmeBaseUrl,
          contentVersion:identity.contentVersion,contentHash:identity.contentHash,hasReadme:true} : undefined;
    },
    queryFn:async({signal})=>{
      try {
        const value = await fetchRepositoryReadme(identity!.id,identity!.contentVersion,identity!.contentHash,await token(),signal);
        authSessionLifecycle.assertCurrent(generation);
        return value;
      } catch (error) {
        authSessionLifecycle.assertCurrent(generation);
        if ((error as {status?:number}).status === 409 && refresh.current.scope===scope && !refresh.current.used) {
          refresh.current.used = true;
          await client.fetchQuery({queryKey:metadataKey,queryFn:async({signal})=>readmeMetadata(await loadMetadata(signal)),staleTime:0});
          authSessionLifecycle.assertCurrent(generation);
        }
        throw error;
      }
    },
  });
  const error = metadata.error ?? document.error;
  const terminalError = [401,403,404,410].includes((error as {status?:number} | null)?.status ?? 0);
  const data = terminalError ? undefined : inline ?? document.data;
  return {data,error,terminalError,isError:Boolean(error),isPending:!error && !data && (metadata.isFetching || document.isPending),
    refetch:()=> !identity ? metadata.refetch() : document.refetch()};
}
