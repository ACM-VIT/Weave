import assert from 'node:assert/strict';
import test from 'node:test';

import type { QueuedActivity } from '../src/api/activity';
import {
  deserializeActivitySnapshot,
  loadNativeActivitySnapshot,
  writeNativeActivitySnapshot,
  type ActivitySnapshotFileSystem,
} from '../src/services/activityOutboxFileStorage';

const MAIN = 'activity.json';
const TEMPORARY = 'activity.json.tmp';

function event(index: number): QueuedActivity {
  return {
    event_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    session_id: '00000000-0000-4000-8000-999999999999',
    client_occurred_at: '2026-07-21T12:00:00.000Z',
    repo_id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    action: 'github_open',
    serve_id: null,
    position: null,
  };
}

class MemoryFileSystem implements ActivitySnapshotFileSystem {
  readonly files = new Map<string, string>();
  readonly warnings: string[] = [];
  failMoveFrom: string | null = null;
  now = () => 42;

  exists(path: string): boolean {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const contents = this.files.get(path);
    if (contents === undefined) throw new Error(`Missing ${path}`);
    return contents;
  }

  writeFresh(path: string, contents: string): void {
    this.files.set(path, contents);
  }

  async move(source: string, destination: string, overwrite: boolean): Promise<void> {
    if (this.failMoveFrom === source) throw new Error('simulated interrupted move');
    const contents = this.files.get(source);
    if (contents === undefined) throw new Error(`Missing ${source}`);
    if (!overwrite && this.files.has(destination)) throw new Error(`Existing ${destination}`);
    this.files.set(destination, contents);
    this.files.delete(source);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

test('snapshot validation rejects a partial or malformed durable queue instead of dropping events', () => {
  assert.deepEqual(deserializeActivitySnapshot(JSON.stringify([event(1)])), [event(1)]);
  assert.throws(() => deserializeActivitySnapshot('{'), /not valid JSON/);
  assert.throws(
    () => deserializeActivitySnapshot(JSON.stringify([event(1), { action: 'like' }])),
    /invalid event_id/,
  );
});

test('snapshot validation upgrades a legitimate pre-session durable event', () => {
  const { session_id: _legacyMissingField, ...legacyEvent } = event(1);
  const [restored] = deserializeActivitySnapshot(JSON.stringify([legacyEvent]));

  assert.match(restored.session_id, /^[0-9a-f-]{36}$/i);
  assert.equal(restored.event_id, legacyEvent.event_id);
});

test('startup preserves a corrupt main snapshot and promotes a valid temporary snapshot', async () => {
  const fileSystem = new MemoryFileSystem();
  fileSystem.files.set(MAIN, '{truncated');
  fileSystem.files.set(TEMPORARY, JSON.stringify([event(2)]));

  const restored = await loadNativeActivitySnapshot(fileSystem, MAIN, TEMPORARY);

  assert.deepEqual(restored, [event(2)]);
  assert.equal(fileSystem.files.get(`${MAIN}.corrupt-42`), '{truncated');
  assert.deepEqual(JSON.parse(fileSystem.files.get(MAIN) ?? ''), [event(2)]);
  assert.equal(fileSystem.files.has(TEMPORARY), false);
  assert.ok(fileSystem.warnings.some((warning) => warning.includes('Preserved corrupt')));
});

test('an interrupted commit leaves a verified temp snapshot that startup can recover', async () => {
  const fileSystem = new MemoryFileSystem();
  fileSystem.files.set(MAIN, JSON.stringify([event(1)]));
  fileSystem.failMoveFrom = TEMPORARY;

  await assert.rejects(
    writeNativeActivitySnapshot(fileSystem, MAIN, TEMPORARY, [event(2)]),
    /interrupted move/,
  );
  assert.deepEqual(JSON.parse(fileSystem.files.get(MAIN) ?? ''), [event(1)]);
  assert.deepEqual(JSON.parse(fileSystem.files.get(TEMPORARY) ?? ''), [event(2)]);

  fileSystem.failMoveFrom = null;
  const restored = await loadNativeActivitySnapshot(fileSystem, MAIN, TEMPORARY);
  assert.deepEqual(restored, [event(2)]);
  assert.deepEqual(JSON.parse(fileSystem.files.get(MAIN) ?? ''), [event(2)]);
});

test('writes rename a corrupt main snapshot before replacing it', async () => {
  const fileSystem = new MemoryFileSystem();
  fileSystem.files.set(MAIN, 'not-json');

  await writeNativeActivitySnapshot(fileSystem, MAIN, TEMPORARY, [event(3)]);

  assert.equal(fileSystem.files.get(`${MAIN}.corrupt-42`), 'not-json');
  assert.deepEqual(JSON.parse(fileSystem.files.get(MAIN) ?? ''), [event(3)]);
});
