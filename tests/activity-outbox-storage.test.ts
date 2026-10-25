import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

test('durable snapshots retain the original impression UUID without inventing absent legacy links',()=>{
  const linked={...event(2),serve_id:'00000000-0000-4000-8000-000000000123',position:0,
    impression_event_id:event(1).event_id};
  assert.deepEqual(deserializeActivitySnapshot(JSON.stringify([linked])),[linked]);
  assert.equal('impression_event_id' in deserializeActivitySnapshot(JSON.stringify([event(3)]))[0],false);
  assert.throws(()=>deserializeActivitySnapshot(JSON.stringify([{...linked,impression_event_id:'invalid'}])),/impression_event_id/);
});


async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}

function processFixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'weave-activity-restart-'));
  const children: ChildProcess[] = [];
  t.after(async () => { await Promise.all(children.map(terminateProcess)); rmSync(directory, { recursive: true, force: true }); });
  const start = (mode: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/fixtures/activity-record-process.ts'), directory, mode],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    const message = new Promise<any>((yes, no) => {
      let output = '';
      child.stdout.on('data', chunk => {
        output += String(chunk); const line = output.indexOf('\n');
        if (line >= 0) { try { yes(JSON.parse(output.slice(0, line))); } catch (error) { no(error); } }
      });
      child.once('error', no); child.once('exit', () => no(new Error('Activity fixture exited before reporting.')));
    });
    return { child, message };
  };
  return { start };
}

for (const mode of ['quota-retry']) {
  test(`real event files survive SIGKILL and fresh-process recovery (${mode})`, { timeout: 10_000 }, async t => {
    const app = processFixture(t); const first = app.start(mode);
    const before = await first.message;
    assert.equal(before.phase, mode === 'interrupt-temp' ? 'verified-temporary' : 'persisted');
    await terminateProcess(first.child); assert.equal(first.child.signalCode, 'SIGKILL');
    const restarted = app.start('load'); const restored = await restarted.message;
    assert.equal(restored.events.length, 1);
    assert.equal(restored.events[0].event_id, '00000000-0000-4000-8000-000000000001');
    assert.equal(restored.events[0].client_occurred_at, '2026-10-23T00:00:00Z');
    const delivered = app.start('acknowledge'); assert.deepEqual(await delivered.message, { phase: 'acknowledged', pending: 0 });
    await terminateProcess(delivered.child);
    assert.deepEqual(await app.start('load').message, { phase: 'loaded', events: [] }, 'acknowledged records cannot resurrect');
  });
}
