import type { QueuedActivity } from '../api/activity';
import { FEEDBACK_ACTIONS, type FeedbackAction } from '../constants/feedbackActions';
import { getAppSessionId } from '../utils/uuid';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activityActions = new Set<string>(Object.values(FEEDBACK_ACTIONS));

export type ActivitySnapshotFileSystem = {
  exists: (path: string) => boolean;
  read: (path: string) => Promise<string>;
  writeFresh: (path: string, contents: string) => void;
  move: (source: string, destination: string, overwrite: boolean) => Promise<void>;
  now?: () => number;
  warn?: (message: string, error?: unknown) => void;
};

type SnapshotRead =
  | { kind: 'missing' }
  | { kind: 'valid'; events: QueuedActivity[] }
  | { kind: 'corrupt'; error: Error };

function validationError(index: number, field: string): Error {
  return new Error(`Activity outbox event ${index} has an invalid ${field}.`);
}

export function deserializeActivitySnapshot(contents: string): QueuedActivity[] {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error('Activity outbox snapshot is not valid JSON.');
  }

  if (!Array.isArray(value)) {
    throw new Error('Activity outbox snapshot must contain an array.');
  }

  return value.map((valueEvent, index) => {
    if (!valueEvent || typeof valueEvent !== 'object') {
      throw validationError(index, 'event');
    }

    const event = valueEvent as Record<string, unknown>;
    if (typeof event.event_id !== 'string' || !UUID_PATTERN.test(event.event_id)) {
      throw validationError(index, 'event_id');
    }
    if (event.session_id !== undefined
      && (typeof event.session_id !== 'string' || !UUID_PATTERN.test(event.session_id))) {
      throw validationError(index, 'session_id');
    }
    if (typeof event.repo_id !== 'string' || !UUID_PATTERN.test(event.repo_id)) {
      throw validationError(index, 'repo_id');
    }
    if (typeof event.client_occurred_at !== 'string'
      || Number.isNaN(Date.parse(event.client_occurred_at))) {
      throw validationError(index, 'client_occurred_at');
    }
    if (typeof event.action !== 'string' || !activityActions.has(event.action)) {
      throw validationError(index, 'action');
    }
    if (event.serve_id !== undefined && event.serve_id !== null
      && (typeof event.serve_id !== 'string' || !UUID_PATTERN.test(event.serve_id))) {
      throw validationError(index, 'serve_id');
    }
    if (event.position !== undefined && event.position !== null
      && (!Number.isInteger(event.position) || Number(event.position) < 0)) {
      throw validationError(index, 'position');
    }
    if (event.dwell_seconds !== undefined
      && (typeof event.dwell_seconds !== 'number' || !Number.isFinite(event.dwell_seconds))) {
      throw validationError(index, 'dwell_seconds');
    }

    return {
      event_id: event.event_id,
      session_id: typeof event.session_id === 'string' ? event.session_id : getAppSessionId(),
      client_occurred_at: event.client_occurred_at,
      repo_id: event.repo_id,
      action: event.action as FeedbackAction,
      ...(typeof event.serve_id === 'string' || event.serve_id === null
        ? { serve_id: event.serve_id } : {}),
      ...(typeof event.position === 'number' || event.position === null
        ? { position: event.position } : {}),
      ...(typeof event.dwell_seconds === 'number'
        ? { dwell_seconds: event.dwell_seconds } : {}),
    };
  });
}

async function readSnapshot(
  fileSystem: ActivitySnapshotFileSystem,
  path: string,
): Promise<SnapshotRead> {
  if (!fileSystem.exists(path)) return { kind: 'missing' };
  try {
    return { kind: 'valid', events: deserializeActivitySnapshot(await fileSystem.read(path)) };
  } catch (error) {
    return {
      kind: 'corrupt',
      error: error instanceof Error ? error : new Error('Activity outbox snapshot is corrupt.'),
    };
  }
}

async function nextBackupPath(
  fileSystem: ActivitySnapshotFileSystem,
  path: string,
): Promise<string> {
  const timestamp = (fileSystem.now ?? Date.now)();
  let suffix = 0;
  let candidate = `${path}.corrupt-${timestamp}`;
  while (fileSystem.exists(candidate)) {
    suffix += 1;
    candidate = `${path}.corrupt-${timestamp}-${suffix}`;
  }
  return candidate;
}

async function preserveCorruptSnapshot(
  fileSystem: ActivitySnapshotFileSystem,
  path: string,
  error: Error,
): Promise<string> {
  const backupPath = await nextBackupPath(fileSystem, path);
  await fileSystem.move(path, backupPath, false);
  fileSystem.warn?.(`Preserved corrupt activity outbox snapshot at ${backupPath}.`, error);
  return backupPath;
}

export async function loadNativeActivitySnapshot(
  fileSystem: ActivitySnapshotFileSystem,
  mainPath: string,
  temporaryPath: string,
): Promise<QueuedActivity[]> {
  const [main, temporary] = await Promise.all([
    readSnapshot(fileSystem, mainPath),
    readSnapshot(fileSystem, temporaryPath),
  ]);

  if (temporary.kind === 'valid') {
    if (main.kind === 'corrupt') {
      try {
        await preserveCorruptSnapshot(fileSystem, mainPath, main.error);
      } catch (error) {
        fileSystem.warn?.(
          'Could not preserve the corrupt activity outbox snapshot; leaving it untouched.',
          error,
        );
        return temporary.events;
      }
    }

    try {
      await fileSystem.move(temporaryPath, mainPath, true);
    } catch (error) {
      // The complete temporary snapshot remains the recovery source if the move is interrupted.
      fileSystem.warn?.('Could not commit the recovered activity outbox snapshot.', error);
    }
    return temporary.events;
  }

  if (temporary.kind === 'corrupt') {
    try {
      await preserveCorruptSnapshot(fileSystem, temporaryPath, temporary.error);
    } catch (error) {
      fileSystem.warn?.('Could not preserve the corrupt temporary activity snapshot.', error);
    }
  }

  if (main.kind === 'valid') return main.events;
  if (main.kind === 'corrupt') {
    try {
      await preserveCorruptSnapshot(fileSystem, mainPath, main.error);
    } catch (error) {
      fileSystem.warn?.(
        'Could not preserve the corrupt activity outbox snapshot; leaving it untouched.',
        error,
      );
    }
  }
  return [];
}

export async function writeNativeActivitySnapshot(
  fileSystem: ActivitySnapshotFileSystem,
  mainPath: string,
  temporaryPath: string,
  events: readonly QueuedActivity[],
): Promise<void> {
  const contents = JSON.stringify(events);
  fileSystem.writeFresh(temporaryPath, contents);

  // Verify the complete temp snapshot before it is allowed to replace the durable copy.
  deserializeActivitySnapshot(await fileSystem.read(temporaryPath));

  const main = await readSnapshot(fileSystem, mainPath);
  if (main.kind === 'corrupt') {
    // Never overwrite unreadable user data without first moving it aside for recovery/diagnostics.
    await preserveCorruptSnapshot(fileSystem, mainPath, main.error);
  }

  await fileSystem.move(temporaryPath, mainPath, true);
}
