import type { QueuedActivity } from '../api/activity';
import {
  deserializeActivitySnapshot,
  loadNativeActivitySnapshot,
  writeNativeActivitySnapshot,
  type ActivitySnapshotFileSystem,
} from './activityOutboxFileStorage';

export type ActivityRecordFileSystem = ActivitySnapshotFileSystem & {
  list: () => Promise<string[]>;
  remove: (path: string) => Promise<void>;
};

type StoredEvent = { event: QueuedActivity; paths: string[] };
const RECORD_NAME = /^event-(\d{16})-([0-9a-f-]{36})\.json(?:\.tmp)?$/i;
const MIGRATION_MARKER = 'migrated-v2.json';

/**
 * Immutable one-event records reuse the verified temp -> main commit protocol.
 * Acknowledgement compacts only the delivered records, never the pending queue.
 * All operations for a user must share this instance (one writer per app runtime).
 */
export class IncrementalActivityStorage {
  private records = new Map<string, StoredEvent>();
  private nextSequence = 0;
  private readonly reservedPaths = new Map<string, string>();
  private initialized = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fileSystem: ActivityRecordFileSystem,
    private readonly loadLegacy: () => Promise<QueuedActivity[]>,
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(operation);
    this.tail = result;
    return result;
  }

  private validatedFileSystem(validate: (events: QueuedActivity[]) => boolean): ActivitySnapshotFileSystem {
    return {
      exists: path => this.fileSystem.exists(path),
      read: async path => {
        const contents = await this.fileSystem.read(path);
        if (!validate(deserializeActivitySnapshot(contents))) throw new Error('Invalid activity record contents.');
        return contents;
      },
      writeFresh: (path, contents) => this.fileSystem.writeFresh(path, contents),
      move: (source, destination, overwrite) => this.fileSystem.move(source, destination, overwrite),
      now: () => this.fileSystem.now?.() ?? Date.now(),
      warn: (message, error) => this.fileSystem.warn?.(message, error),
    };
  }

  private recordFileSystem(eventId: string): ActivitySnapshotFileSystem {
    return this.validatedFileSystem(events => events.length === 1 && events[0].event_id === eventId);
  }

  private async validSnapshot(path: string, fileSystem: ActivitySnapshotFileSystem): Promise<boolean> {
    if (!fileSystem.exists(path)) return false;
    try {
      deserializeActivitySnapshot(await fileSystem.read(path));
      return true;
    } catch {
      return false;
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    // Build fresh state on every failed initialization retry; never expose a partial migration.
    const records = new Map<string, StoredEvent>();
    const paths = new Map<string, string>();
    let nextSequence = 0;
    for (const name of await this.fileSystem.list()) {
      const match = RECORD_NAME.exec(name);
      if (!match) continue;
      const sequence = Number(match[1]);
      if (!Number.isSafeInteger(sequence)) throw new Error('Activity record sequence is invalid.');
      nextSequence = Math.max(nextSequence, sequence + 1);
      paths.set(name.replace(/\.tmp$/, ''), match[2]);
    }
    for (const [path, eventId] of [...paths].sort(([left], [right]) => left.localeCompare(right))) {
      const fileSystem = this.recordFileSystem(eventId);
      const temporaryPath = `${path}.tmp`;
      const mainValid = await this.validSnapshot(path, fileSystem);
      const temporaryValid = await this.validSnapshot(temporaryPath, fileSystem);
      if ((this.fileSystem.exists(path) && !mainValid && !temporaryValid)
        || (!mainValid && this.fileSystem.exists(temporaryPath) && !temporaryValid)) {
        // Leave unreadable records untouched and block, rather than silently dropping an unsent event.
        throw new Error(`Activity outbox record could not be recovered: ${path}`);
      }
      const [event] = await loadNativeActivitySnapshot(fileSystem, path, temporaryPath);
      if (!event || !await this.validSnapshot(path, fileSystem)) {
        throw new Error(`Activity outbox record could not be committed: ${path}`);
      }
      const existing = records.get(event.event_id);
      if (existing) existing.paths.push(path);
      else records.set(event.event_id, { event, paths: [path] });
    }

    const markerFileSystem = this.validatedFileSystem(events => events.length === 0);
    if (!await this.validSnapshot(MIGRATION_MARKER, markerFileSystem)) {
      // A missing/partial marker means import may be incomplete. Legacy data is never deleted.
      // No enqueue or acknowledgement can interleave with import before this marker commits.
      for (const event of await this.loadLegacy()) {
        if (records.has(event.event_id)) continue;
        if (!Number.isSafeInteger(nextSequence)) throw new Error('Activity record sequence exhausted.');
        const path = this.recordPath(nextSequence++, event.event_id);
        await writeNativeActivitySnapshot(this.recordFileSystem(event.event_id), path, `${path}.tmp`, [event]);
        records.set(event.event_id, { event, paths: [path] });
      }
      // Every import has a validated temporary copy and a successful main-file move before this marker.
      await writeNativeActivitySnapshot(markerFileSystem, MIGRATION_MARKER, `${MIGRATION_MARKER}.tmp`, []);
    }
    this.records = records;
    this.nextSequence = nextSequence;
    this.initialized = true;
  }

  private recordPath(sequence: number, eventId: string): string {
    return `event-${String(sequence).padStart(16, '0')}-${eventId}.json`;
  }

  load(): Promise<QueuedActivity[]> {
    return this.serialize(async () => {
      await this.initialize();
      return [...this.records.values()].map(record => record.event);
    });
  }

  append(event: QueuedActivity): Promise<void> {
    return this.serialize(async () => {
      // Validate one event before its ID can become a file/key path.
      [event] = deserializeActivitySnapshot(JSON.stringify([event]));
      await this.initialize();
      if (this.records.has(event.event_id)) return;
      if (!Number.isSafeInteger(this.nextSequence)) throw new Error('Activity record sequence exhausted.');
      let path = this.reservedPaths.get(event.event_id);
      if (!path) {
        path = this.recordPath(this.nextSequence++, event.event_id);
        this.reservedPaths.set(event.event_id, path);
      }
      // A failed write retries the same path; a verified temporary copy remains restart-recoverable.
      await writeNativeActivitySnapshot(this.recordFileSystem(event.event_id), path, `${path}.tmp`, [event]);
      this.records.set(event.event_id, { event, paths: [path] });
      this.reservedPaths.delete(event.event_id);
    });
  }

  acknowledge(eventIds: ReadonlySet<string>): Promise<void> {
    return this.serialize(async () => {
      await this.initialize();
      for (const eventId of eventIds) {
        const record = this.records.get(eventId);
        if (!record) continue;
        for (const path of record.paths) {
          // Never leave a recoverable temp behind after deleting its committed main record.
          await this.fileSystem.remove(`${path}.tmp`);
          await this.fileSystem.remove(path);
        }
        this.records.delete(eventId);
      }
    });
  }
}
