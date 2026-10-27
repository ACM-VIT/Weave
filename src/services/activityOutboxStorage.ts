import { Platform } from 'react-native';

import type { QueuedActivity } from '../api/activity';
import {
  deserializeActivitySnapshot,
  loadNativeActivitySnapshot,
  type ActivitySnapshotFileSystem,
} from './activityOutboxFileStorage';
import { IncrementalActivityStorage, type ActivityRecordFileSystem } from './activityOutboxRecordStorage';

const LEGACY_KEY_PREFIX = 'ghsocial.activity-outbox.v2';
const RECORD_KEY_PREFIX = 'ghsocial.activity-outbox.v3';
// Explicitly separate test/backend databases that can reuse account UUIDs.
// Unscoped work remains untouched; its source must be recovered independently.
const STORAGE_SCOPE = process.env.EXPO_PUBLIC_ACTIVITY_STORAGE_SCOPE?.trim();
const ACCOUNT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const userStores = new Map<string, Promise<IncrementalActivityStorage>>();

function legacyUserId(userId: string): string {
  // v2 records have no embedded owner. Only canonical account IDs have an unambiguous old key;
  // arbitrary strings could alias another user's lossy character-replacement namespace.
  if (!ACCOUNT_UUID.test(userId)) throw new Error('A canonical account UUID is required for activity migration.');
  return userId;
}

async function createStorage(userId: string): Promise<IncrementalActivityStorage> {
  // Use an injective, path-safe encoding rather than replacing characters or interpolating URI separators.
  const encodedUser = userId.split('').map(character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const encodedScope = STORAGE_SCOPE?.split('').map(character => character.charCodeAt(0).toString(16).padStart(4,'0')).join('');
  const namespace = `${RECORD_KEY_PREFIX}${encodedScope ? `.scope.${encodedScope}` : ''}.${encodedUser}`;
  if (Platform.OS === 'web') {
    if (typeof localStorage === 'undefined') throw new Error('Activity outbox storage is unavailable.');
    const prefix = `${namespace}.`;
    const fileSystem: ActivityRecordFileSystem = {
      exists: path => localStorage.getItem(prefix + path) !== null,
      read: async path => {
        const contents = localStorage.getItem(prefix + path);
        if (contents === null) throw new Error('Activity record is missing.');
        return contents;
      },
      writeFresh: (path, contents) => localStorage.setItem(prefix + path, contents),
      move: async (source, destination, overwrite) => {
        const contents = localStorage.getItem(prefix + source);
        if (contents === null) throw new Error('Activity record is missing.');
        if (!overwrite && localStorage.getItem(prefix + destination) !== null) throw new Error('Activity record already exists.');
        // setItem is atomic; quota failure leaves the source and previous destination untouched.
        localStorage.setItem(prefix + destination, contents);
        localStorage.removeItem(prefix + source);
      },
      list: async () => {
        const paths: string[] = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key?.startsWith(prefix)) paths.push(key.slice(prefix.length));
        }
        return paths;
      },
      remove: async path => localStorage.removeItem(prefix + path),
      warn: (message, error) => console.warn(message, error),
    };
    return new IncrementalActivityStorage(fileSystem, async () => {
      if (STORAGE_SCOPE) return [];
      const value = localStorage.getItem(`${LEGACY_KEY_PREFIX}.${legacyUserId(userId)}`);
      // Do not overwrite or silently normalize away a malformed legacy event.
      return value === null ? [] : deserializeActivitySnapshot(value);
    });
  }

  const { Directory, File, Paths } = await import('expo-file-system');
  const directory = new Directory(Paths.document, namespace);
  directory.create({ intermediates: true, idempotent: true });
  const snapshotFileSystem = (root: typeof directory): ActivitySnapshotFileSystem => ({
    exists: path => new File(root, path).exists,
    read: path => new File(root, path).text(),
    writeFresh: (path, contents) => {
      const file = new File(root, path);
      file.create({ intermediates: true, overwrite: true });
      file.write(contents);
    },
    move: async (source, destination, overwrite) => {
      await new File(root, source).move(new File(root, destination), { overwrite });
    },
    warn: (message, error) => console.warn(message, error),
  });
  const fileSystem: ActivityRecordFileSystem = {
    ...snapshotFileSystem(directory),
    list: async () => directory.list().filter(entry => entry instanceof File).map(entry => entry.name),
    remove: async path => {
      const file = new File(directory, path);
      if (file.exists) file.delete();
    },
  };
  return new IncrementalActivityStorage(fileSystem, async () => {
      if (STORAGE_SCOPE) return [];
    const legacy = snapshotFileSystem(Paths.document);
    const path = `${LEGACY_KEY_PREFIX}.${legacyUserId(userId)}.json`;
    const temporaryPath = `${path}.tmp`;
    const existed = legacy.exists(path) || legacy.exists(temporaryPath);
    // A corrupt main must remain in place if neither source is readable.
    // Existing recovery then promotes valid temp data and preserves corrupt copies as before.
    if (existed) {
      let readable = false;
      for (const candidate of [path, temporaryPath]) {
        if (!legacy.exists(candidate)) continue;
        try { deserializeActivitySnapshot(await legacy.read(candidate)); readable = true; }
        catch { /* The other copy may still be recoverable. */ }
      }
      if (!readable) throw new Error('The legacy activity outbox is corrupt; its files were left untouched.');
    }
    return loadNativeActivitySnapshot(legacy, path, temporaryPath);
  });
}

function getStorage(userId: string): Promise<IncrementalActivityStorage> {
  let store = userStores.get(userId);
  if (!store) {
    store = createStorage(userId);
    userStores.set(userId, store);
    void store.catch(() => {
      if (userStores.get(userId) === store) userStores.delete(userId);
    });
  }
  return store;
}

export async function loadActivityOutbox(userId: string): Promise<QueuedActivity[]> {
  return (await getStorage(userId)).load();
}

export async function appendActivityOutboxEvent(userId: string, event: QueuedActivity): Promise<void> {
  return (await getStorage(userId)).append(event);
}

export async function acknowledgeActivityOutboxEvents(userId: string, eventIds: ReadonlySet<string>): Promise<void> {
  return (await getStorage(userId)).acknowledge(eventIds);
}
