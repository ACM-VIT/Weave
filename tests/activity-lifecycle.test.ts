import assert from 'node:assert/strict';
import test from 'node:test';
import { startActivityOutboxLifecycle } from '../src/services/activityOutboxLifecycle';
import { DurableActivityOutbox } from '../src/services/activityOutbox';
import type { QueuedActivity } from '../src/api/activity';

test('foreground/background, network restoration and orderly unmount wake the queue; retired listeners stay silent', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let state!: (value: string) => void;
  let connectivity!: (value: { isConnected: boolean | null; isInternetReachable: boolean | null }) => void;
  let flushes = 0; let removed = 0;
  const stop = startActivityOutboxLifecycle({ flush: async () => { flushes++; }, intervalMs: 8000,
    subscribeAppState: listener => { state = listener; return () => { removed++; }; },
    subscribeConnectivity: listener => { connectivity = listener; return () => { removed++; }; },
  });
  assert.equal(flushes, 1);
  state('background'); state('active'); assert.equal(flushes, 3);
  connectivity({ isConnected: null, isInternetReachable: null });
  connectivity({ isConnected: false, isInternetReachable: false }); assert.equal(flushes, 3);
  connectivity({ isConnected: true, isInternetReachable: false }); assert.equal(flushes, 3);
  connectivity({ isConnected: true, isInternetReachable: true }); assert.equal(flushes, 4);
  connectivity({ isConnected: true, isInternetReachable: true }); assert.equal(flushes, 4);
  t.mock.timers.tick(8000); assert.equal(flushes, 5);
  stop(); assert.equal(flushes, 6); assert.equal(removed, 2);
  state('active'); connectivity({ isConnected: true, isInternetReachable: true });
  t.mock.timers.tick(16000); stop(); assert.equal(flushes, 6);
});

test('network recovery reuses durable event identity and retains the existing retry backoff', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const event: QueuedActivity = { event_id: '00000000-0000-4000-8000-000000000001',
    session_id: '00000000-0000-4000-8000-000000000002', repo_id: '00000000-0000-4000-8000-000000000003',
    action: 'like', client_occurred_at: '2026-10-23T00:00:00Z', serve_id: null, position: null };
  let stored = [event]; let online = false; let now = 0; let requests = 0;
  const queue = new DurableActivityOutbox({ load: async () => stored, persist: async events => { stored = [...events]; },
    now: () => now, prepare: input => input as QueuedActivity, send: async events => {
      requests++; if (!online) throw new Error('offline');
      assert.deepEqual(events, [event]);
      return { accepted: 1, duplicates: 0, feed_version: '2', results: [{ event_id: event.event_id, status: 'accepted' }] };
    },
  });
  await assert.rejects(queue.flush('token'), /offline/);
  let connectivity!: (value: { isConnected: boolean | null; isInternetReachable: boolean | null }) => void;
  const stop = startActivityOutboxLifecycle({ flush: () => queue.flush('token'), intervalMs: 8000,
    subscribeAppState: () => () => {}, subscribeConnectivity: listener => { connectivity = listener; return () => {}; } });
  online = true;
  connectivity({ isConnected: true, isInternetReachable: true });
  await queue.flush('token'); assert.equal(requests, 1, 'lifecycle signals do not bypass failed-delivery backoff');
  now = 1000;
  connectivity({ isConnected: false, isInternetReachable: false });
  connectivity({ isConnected: true, isInternetReachable: true });
  await queue.flush('token'); assert.equal(requests, 2); assert.deepEqual(stored, []);
  stop();
});
