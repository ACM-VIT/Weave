import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { stopFixtureProcess } from './fixtureProcess.js';

test('fixture cleanup escalates when the child ignores SIGTERM', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  const stopping = stopFixtureProcess(child, 20, 2000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([stopping.then(() => true), new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), 1000);
  })]);
  clearTimeout(timer);
  if (!completed) { child.kill('SIGKILL'); await stopping; }
  assert.equal(completed, true, 'cleanup must force a stuck fixture to exit');
  assert.equal(child.signalCode, 'SIGKILL');
});

test('fixture cleanup permits graceful exit and is harmless after exit', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000)"],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  await stopFixtureProcess(child, 1000, 2000);
  assert.equal(child.exitCode, 0);
  await stopFixtureProcess(child, 20, 20);
});
