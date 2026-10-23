import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'weave-activity-restart-'));
  const children: ChildProcess[] = [];
  t.after(async () => { await Promise.all(children.map(terminate)); rmSync(directory, { recursive: true, force: true }); });
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

for (const mode of ['enqueue', 'offline', 'interrupt-temp']) {
  test(`real event files survive SIGKILL and fresh-process recovery (${mode})`, { timeout: 10_000 }, async t => {
    const app = fixture(t); const first = app.start(mode);
    const before = await first.message;
    assert.equal(before.phase, mode === 'interrupt-temp' ? 'verified-temporary' : 'persisted');
    await terminate(first.child); assert.equal(first.child.signalCode, 'SIGKILL');
    const restarted = app.start('load'); const restored = await restarted.message;
    assert.equal(restored.events.length, 1);
    assert.equal(restored.events[0].event_id, '00000000-0000-4000-8000-000000000001');
    assert.equal(restored.events[0].client_occurred_at, '2026-10-23T00:00:00Z');
    const delivered = app.start('acknowledge'); assert.deepEqual(await delivered.message, { phase: 'acknowledged', pending: 0 });
    await terminate(delivered.child);
    assert.deepEqual(await app.start('load').message, { phase: 'loaded', events: [] }, 'acknowledged records cannot resurrect');
  });
}
