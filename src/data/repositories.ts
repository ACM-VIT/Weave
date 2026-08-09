import type { RepositoryDetail } from '@/models/repository';

/** @deprecated Import RepositoryDetail from '@/models/repository'. */
export type RepositoryData = RepositoryDetail;

// Production repository surfaces are API-backed. Development preview records
// live in development-repositories.ts and also pass through the central mapper.
export const REPOSITORIES: RepositoryDetail[] = [];
