import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import type { RepositoryData } from '@/data/repositories';
import {
  parsePinnedRepositories,
  serializePinnedRepositories,
  type PinnedRepository,
} from '@/services/pinnedRepositoryCodec';
import { getStorageItem, removeStorageItem, setStorageItem } from '@/utils/storage';

export type { PinnedRepository } from '@/services/pinnedRepositoryCodec';

const writeQueues = new Map<string, Promise<void>>();
const migrationReads = new Map<string, Promise<string | null>>();

function storageKey(userId: string) {
  return `weave.pinned-repositories.${userId}`;
}

function nativeFileName(userId: string) {
  const encodedUserId = encodeURIComponent(userId).replace(/\./g, '%2E');
  return `weave-pinned-repositories-v1-${encodedUserId}.json`;
}

function nativeFile(userId: string) {
  return new File(Paths.document, nativeFileName(userId));
}

function assertUserId(userId: string) {
  if (!userId.trim()) throw new Error('A user id is required to store pinned repositories.');
}

async function writeNativePayload(userId: string, payload: string): Promise<void> {
  const destination = nativeFile(userId);
  const temporary = new File(Paths.document, `${nativeFileName(userId)}.tmp`);
  temporary.create({ overwrite: true });
  temporary.write(payload);
  await temporary.move(destination, { overwrite: true });
}

async function migrateLegacyNativePayload(userId: string): Promise<string | null> {
  const legacyKey = storageKey(userId);
  const legacyPayload = await getStorageItem(legacyKey);
  if (legacyPayload === null) return null;

  await writeNativePayload(userId, legacyPayload);
  await removeStorageItem(legacyKey).catch(() => undefined);
  return legacyPayload;
}

async function readNativePayload(userId: string): Promise<string | null> {
  const file = nativeFile(userId);
  if (file.exists) return file.text();

  const existingMigration = migrationReads.get(userId);
  if (existingMigration) return existingMigration;

  const migration = migrateLegacyNativePayload(userId);
  migrationReads.set(userId, migration);
  try {
    return await migration;
  } finally {
    if (migrationReads.get(userId) === migration) migrationReads.delete(userId);
  }
}

async function readPayload(userId: string): Promise<string | null> {
  assertUserId(userId);
  if (Platform.OS === 'web') return getStorageItem(storageKey(userId));
  return readNativePayload(userId);
}

async function writePayload(userId: string, payload: string): Promise<void> {
  assertUserId(userId);
  if (Platform.OS === 'web') {
    await setStorageItem(storageKey(userId), payload);
    return;
  }
  await writeNativePayload(userId, payload);
}

export function pinnedRepositoryKey(repository: Pick<RepositoryData, 'id' | 'owner' | 'name'>) {
  return `${repository.id}:${repository.owner}/${repository.name}`;
}

export async function loadPinnedRepositories(userId: string): Promise<PinnedRepository[]> {
  return parsePinnedRepositories(await readPayload(userId));
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
          name: repository.name,
          owner: repository.owner,
          description: repository.description || 'No description provided.',
          primaryLanguage: repository.primaryLanguage ?? repository.languages[0] ?? null,
          url: repository.githubUrl
            ?? `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
          pinnedAt: new Date().toISOString(),
        }, ...withoutRepository]
      : withoutRepository;

    await writePayload(userId, serializePinnedRepositories(nextRepositories));
  });

  writeQueues.set(userId, nextWrite);
  try {
    await nextWrite;
  } finally {
    if (writeQueues.get(userId) === nextWrite) writeQueues.delete(userId);
  }
}
