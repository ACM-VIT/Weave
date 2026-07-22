import { Platform } from 'react-native';

import {
  prepareQueuedActivity,
  type ActivityInput,
  type QueuedActivity,
} from '../api/activity';
import { FEEDBACK_ACTIONS, type FeedbackAction } from '../constants/feedbackActions';
import {
  loadNativeActivitySnapshot,
  writeNativeActivitySnapshot,
  type ActivitySnapshotFileSystem,
} from './activityOutboxFileStorage';

const WEB_KEY_PREFIX = 'ghsocial.activity-outbox.v2';
const pendingWrites = new Map<string, Promise<void>>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activityActions = new Set<string>(Object.values(FEEDBACK_ACTIONS));

function safeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9-]/g, '_');
}

function normalize(value: unknown): QueuedActivity[] {
  if (!Array.isArray(value)) return [];
  const normalized: QueuedActivity[] = [];
  for (const valueEvent of value) {
    if (!valueEvent || typeof valueEvent !== 'object') continue;
    const event = valueEvent as Record<string, unknown>;
    if (typeof event.event_id !== 'string' || !UUID_PATTERN.test(event.event_id)
      || typeof event.repo_id !== 'string' || !UUID_PATTERN.test(event.repo_id)
      || typeof event.client_occurred_at !== 'string' || Number.isNaN(Date.parse(event.client_occurred_at))
      || typeof event.action !== 'string' || !activityActions.has(event.action)
      || (event.session_id !== undefined
        && (typeof event.session_id !== 'string' || !UUID_PATTERN.test(event.session_id)))
      || (event.serve_id !== undefined && event.serve_id !== null
        && (typeof event.serve_id !== 'string' || !UUID_PATTERN.test(event.serve_id)))
      || (event.position !== undefined && event.position !== null
        && (!Number.isInteger(event.position) || Number(event.position) < 0))
      || (event.dwell_seconds !== undefined
        && (typeof event.dwell_seconds !== 'number' || !Number.isFinite(event.dwell_seconds)))) {
      continue;
    }

    const input: ActivityInput = {
      event_id: event.event_id,
      client_occurred_at: event.client_occurred_at,
      repo_id: event.repo_id,
      action: event.action as FeedbackAction,
      ...(typeof event.session_id === 'string' ? { session_id: event.session_id } : {}),
      ...(typeof event.serve_id === 'string' || event.serve_id === null
        ? { serve_id: event.serve_id } : {}),
      ...(typeof event.position === 'number' || event.position === null
        ? { position: event.position } : {}),
      ...(typeof event.dwell_seconds === 'number'
        ? { dwell_seconds: event.dwell_seconds } : {}),
    };
    normalized.push(prepareQueuedActivity(input));
  }
  return normalized;
}

export async function loadActivityOutbox(userId: string): Promise<QueuedActivity[]> {
  try {
    await pendingWrites.get(userId)?.catch(() => undefined);
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return [];
      const value = localStorage.getItem(`${WEB_KEY_PREFIX}.${safeUserId(userId)}`);
      return value ? normalize(JSON.parse(value)) : [];
    }

    const { File, Paths } = await import('expo-file-system');
    const fileName = `${WEB_KEY_PREFIX}.${safeUserId(userId)}.json`;
    const temporaryFileName = `${fileName}.tmp`;
    const fileSystem: ActivitySnapshotFileSystem = {
      exists: (path) => new File(Paths.document, path).exists,
      read: (path) => new File(Paths.document, path).text(),
      writeFresh: (path, contents) => {
        const file = new File(Paths.document, path);
        file.create({ intermediates: true, overwrite: true });
        file.write(contents);
      },
      move: async (source, destination, overwrite) => {
        await new File(Paths.document, source).move(
          new File(Paths.document, destination),
          { overwrite },
        );
      },
      warn: (message, error) => console.warn(message, error),
    };
    return loadNativeActivitySnapshot(fileSystem, fileName, temporaryFileName);
  } catch (error) {
    console.warn('Could not restore the activity outbox:', error);
    return [];
  }
}

async function writeActivityOutbox(userId: string, events: readonly QueuedActivity[]): Promise<void> {
  const snapshot = [...events];
  if (Platform.OS === 'web') {
    if (typeof localStorage === 'undefined') return;
    const key = `${WEB_KEY_PREFIX}.${safeUserId(userId)}`;
    if (snapshot.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(snapshot));
    return;
  }

  const { File, Paths } = await import('expo-file-system');
  const fileName = `${WEB_KEY_PREFIX}.${safeUserId(userId)}.json`;
  const temporaryFileName = `${fileName}.tmp`;
  const fileSystem: ActivitySnapshotFileSystem = {
    exists: (path) => new File(Paths.document, path).exists,
    read: (path) => new File(Paths.document, path).text(),
    writeFresh: (path, contents) => {
      const file = new File(Paths.document, path);
      file.create({ intermediates: true, overwrite: true });
      file.write(contents);
    },
    move: async (source, destination, overwrite) => {
      await new File(Paths.document, source).move(
        new File(Paths.document, destination),
        { overwrite },
      );
    },
    warn: (message, error) => console.warn(message, error),
  };
  await writeNativeActivitySnapshot(fileSystem, fileName, temporaryFileName, snapshot);
}

export function persistActivityOutbox(userId: string, events: readonly QueuedActivity[]): Promise<void> {
  const snapshot = [...events];
  const previous = pendingWrites.get(userId) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(() => writeActivityOutbox(userId, snapshot));
  pendingWrites.set(userId, write);

  return write.catch((error) => {
    console.warn('Could not persist the activity outbox:', error);
    throw error;
  }).finally(() => {
    if (pendingWrites.get(userId) === write) pendingWrites.delete(userId);
  });
}
