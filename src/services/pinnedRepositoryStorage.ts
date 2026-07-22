import type { RepositoryData } from '@/data/repositories';
import { getStorageItem, setStorageItem } from '@/utils/storage';

const STORAGE_VERSION = 1;

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
  version: typeof STORAGE_VERSION;
  repositories: PinnedRepository[];
};

const writeQueues = new Map<string, Promise<void>>();

function storageKey(userId: string) {
  return `weave.pinned-repositories.${userId}`;
}

export function pinnedRepositoryKey(repository: Pick<RepositoryData, 'id' | 'owner' | 'title'>) {
  return `${repository.id}:${repository.owner}/${repository.title}`;
}

function isPinnedRepository(value: unknown): value is PinnedRepository {
  if (!value || typeof value !== 'object') return false;
  const repository = value as Partial<PinnedRepository>;
  return typeof repository.key === 'string'
    && typeof repository.repositoryId === 'string'
    && typeof repository.name === 'string'
    && typeof repository.owner === 'string'
    && typeof repository.description === 'string'
    && (repository.primaryLanguage === null || typeof repository.primaryLanguage === 'string')
    && typeof repository.url === 'string'
    && typeof repository.pinnedAt === 'string';
}

export async function loadPinnedRepositories(userId: string): Promise<PinnedRepository[]> {
  const raw = await getStorageItem(storageKey(userId));
  if (!raw) return [];

  try {
    const stored = JSON.parse(raw) as Partial<StoredPinnedRepositories>;
    if (stored.version !== STORAGE_VERSION || !Array.isArray(stored.repositories)) return [];
    return stored.repositories.filter(isPinnedRepository);
  } catch {
    return [];
  }
}

export async function setRepositoryPinned(
  userId: string,
  repository: RepositoryData,
  pinned: boolean,
): Promise<void> {
  const key = pinnedRepositoryKey(repository);
  const previousWrite = writeQueues.get(userId) ?? Promise.resolve();
  const nextWrite = previousWrite.catch(() => undefined).then(async () => {
    const repositories = await loadPinnedRepositories(userId);
    const withoutRepository = repositories.filter((item) => item.key !== key);
    const nextRepositories = pinned
      ? [{
          key,
          repositoryId: repository.id,
          name: repository.title,
          owner: repository.owner,
          description: repository.description || 'No description provided.',
          primaryLanguage: repository.techStack?.[0] ?? null,
          url: `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.title)}`,
          pinnedAt: new Date().toISOString(),
        }, ...withoutRepository]
      : withoutRepository;

    const payload: StoredPinnedRepositories = {
      version: STORAGE_VERSION,
      repositories: nextRepositories,
    };
    await setStorageItem(storageKey(userId), JSON.stringify(payload));
  });

  writeQueues.set(userId, nextWrite);
  try {
    await nextWrite;
  } finally {
    if (writeQueues.get(userId) === nextWrite) writeQueues.delete(userId);
  }
}
