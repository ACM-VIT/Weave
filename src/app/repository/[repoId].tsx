import { useLocalSearchParams } from 'expo-router';

import { RepositoryDetailScreen } from '@/components/repository-detail-screen';

function firstRouteParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export default function RepositoryDetailRoute() {
  const { repoId } = useLocalSearchParams<{ repoId?: string | string[] }>();

  return <RepositoryDetailScreen repositoryId={firstRouteParam(repoId)} />;
}
