import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';

/** Give fixtures a bounded graceful shutdown, then reap an unresponsive child. */
export async function stopFixtureProcess(child: ChildProcess, graceMs = 2000, killWaitMs = 2000): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const wait = async (milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  };
  child.kill('SIGTERM');
  if (await wait(graceMs)) return;
  child.kill('SIGKILL');
  if (!await wait(killWaitMs)) throw new Error('Contract fixture did not exit after SIGKILL.');
}
