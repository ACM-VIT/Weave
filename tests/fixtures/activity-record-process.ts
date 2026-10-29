import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { IncrementalActivityStorage } from '../../src/services/activityOutboxRecordStorage';
import { DurableActivityOutbox } from '../../src/services/activityOutbox';
import type { QueuedActivity } from '../../src/api/activity';

const [directory, mode] = process.argv.slice(2);
if (!directory || !mode) throw new Error('A private fixture directory and phase are required.');
if (dirname(realpathSync(directory)) !== realpathSync(tmpdir()) || !basename(directory).startsWith('weave-activity-restart-')) {
  throw new Error('Select the private temporary activity fixture directory.');
}
const file = (name: string) => { if (basename(name) !== name) throw new Error('Unsafe fixture path'); return join(directory, name); };
const report = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const hold = () => { setInterval(() => {}, 1000); };
let quota = mode === 'quota-retry';
let sends = 0;
const storage = new IncrementalActivityStorage({
  exists: name => existsSync(file(name)), read: async name => readFileSync(file(name), 'utf8'),
  writeFresh: (name, contents) => {
    if (quota && name.startsWith('event-')) throw new Error('Fixture storage quota exceeded');
    writeFileSync(file(name), contents);
  },
  move: async (source, destination, overwrite) => {
    if (mode === 'interrupt-temp' && source.startsWith('event-') && source.endsWith('.tmp')) {
      report({ phase: 'verified-temporary' }); hold(); await new Promise(() => {});
    }
    if (!overwrite && existsSync(file(destination))) throw new Error('Fixture destination exists');
    renameSync(file(source), file(destination));
  },
  list: async () => readdirSync(directory),
  remove: async name => { if (existsSync(file(name))) unlinkSync(file(name)); },
}, async () => []);
const value: QueuedActivity = {
  event_id: '00000000-0000-4000-8000-000000000001', session_id: '00000000-0000-4000-8000-000000000002',
  repo_id: '00000000-0000-4000-8000-000000000003', action: 'like', client_occurred_at: '2026-10-23T00:00:00Z',
  serve_id: null, position: null,
};
async function main() {
  const queue = new DurableActivityOutbox({ load: () => storage.load(), append: event => storage.append(event),
    acknowledge: ids => storage.acknowledge(ids), prepare: input => input as QueuedActivity,
    send: async events => {
      sends++;
      if (mode !== 'acknowledge') throw new Error('offline');
      return { accepted: events.length, duplicates: 0, feed_version: '2',
        results: events.map(event => ({ event_id: event.event_id, status: 'accepted' as const })) };
    },
  });
  if (mode === 'load') { report({ phase: 'loaded', events: await storage.load() }); return; }
  if (mode === 'acknowledge') {
    await queue.flush('fixture-token'); report({ phase: 'acknowledged', pending: await queue.pendingCount() }); hold(); return;
  }
  if (mode === 'quota-retry') {
    let failed = false;
    try { await queue.enqueue(value); } catch { failed = true; }
    if (!failed || sends !== 0 || (await storage.load()).length !== 0) throw new Error('Failed enqueue must not send or claim durability');
    quota = false;
    // The same retained event is persisted by retry; no second enqueue/UUID.
    try { await queue.flush('fixture-token'); } catch { /* Deliberate offline transport after persistence. */ }
  } else await queue.enqueue(value);
  if (mode === 'offline') { try { await queue.flush('fixture-token'); } catch { /* Deliberate unavailable transport. */ } }
  report({ phase: 'persisted', events: await storage.load() }); hold();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
