export const PINNED_REPOSITORY_STORAGE_VERSION = 1 as const;
export const MAX_PINNED_DESCRIPTION_LENGTH = 1_000;

export type PinnedRepository = {
  key: string;
  repositoryId: string;
  name: string;
  owner: string;
  description: string;
  primaryLanguage: string | null;
  url: string;
  pinnedAt: string;
};

type StoredPinnedRepositories = {
  version: typeof PINNED_REPOSITORY_STORAGE_VERSION;
  repositories: PinnedRepository[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizePinnedRepository(value: unknown): PinnedRepository | null {
  if (!isRecord(value)
    || !isNonEmptyString(value.key)
    || !isNonEmptyString(value.repositoryId)
    || !isNonEmptyString(value.name)
    || !isNonEmptyString(value.owner)
    || typeof value.description !== 'string'
    || (value.primaryLanguage !== null && typeof value.primaryLanguage !== 'string')
    || !isNonEmptyString(value.url)
    || !isNonEmptyString(value.pinnedAt)) {
    return null;
  }

  return {
    key: value.key,
    repositoryId: value.repositoryId,
    name: value.name,
    owner: value.owner,
    description: value.description.slice(0, MAX_PINNED_DESCRIPTION_LENGTH),
    primaryLanguage: value.primaryLanguage,
    url: value.url,
    pinnedAt: value.pinnedAt,
  };
}

function normalizePinnedRepositories(values: unknown[]): PinnedRepository[] {
  const seen = new Set<string>();
  const repositories: PinnedRepository[] = [];

  for (const value of values) {
    const repository = normalizePinnedRepository(value);
    if (!repository || seen.has(repository.key)) continue;
    seen.add(repository.key);
    repositories.push(repository);
  }

  return repositories;
}

export function parsePinnedRepositories(raw: string | null | undefined): PinnedRepository[] {
  if (!raw) return [];

  try {
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored)
      || stored.version !== PINNED_REPOSITORY_STORAGE_VERSION
      || !Array.isArray(stored.repositories)) {
      return [];
    }
    return normalizePinnedRepositories(stored.repositories);
  } catch {
    return [];
  }
}

export function serializePinnedRepositories(repositories: PinnedRepository[]): string {
  const stored: StoredPinnedRepositories = {
    version: PINNED_REPOSITORY_STORAGE_VERSION,
    repositories: normalizePinnedRepositories(repositories),
  };
  return JSON.stringify(stored);
}
