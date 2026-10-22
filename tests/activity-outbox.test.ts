import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ActivityInput,
  InteractionBatchResultV2,
  QueuedActivity,
} from '../src/api/activity';
import { DurableActivityOutbox, type ActivityFlushResult } from '../src/services/activityOutbox';

function event(index: number, action: QueuedActivity['action'] = 'impression'): QueuedActivity {
  return {
    event_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    session_id: '00000000-0000-4000-8000-999999999999',
    client_occurred_at: '2026-07-21T12:00:00.000Z',
    repo_id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    action,
    serve_id: null,
    position: null,
  };
}

function acknowledgement(events: QueuedActivity[]): InteractionBatchResultV2 {
  return {
    accepted: events.length,
    duplicates: 0,
    feed_version: '2',
    results: events.map((queued) => ({ event_id: queued.event_id, status: 'accepted' })),
  };
}

const prepare = (input: ActivityInput): QueuedActivity => input as QueuedActivity;

test('durable outbox persists before sending, chunks at 50, and retains deferred regeneration state', async () => {
  const initial = Array.from({ length: 121 }, (_, index) => event(index, index === 0 ? 'like' : 'impression'));
  let stored = [...initial];
  const batchSizes: number[] = [];

  const outbox = new DurableActivityOutbox({
    load: async () => [...stored],
    persist: async (events) => { stored = [...events]; },
    prepare,
    send: async (batch) => {
      assert.ok(batch.every((queued) => stored.some((saved) => saved.event_id === queued.event_id)));
      batchSizes.push(batch.length);
      return acknowledgement(batch);
    },
  });

  const result = await outbox.flush('token');
  assert.deepEqual(batchSizes, [50, 50, 21]);
  assert.equal(result.delivered, 121);
  assert.equal(result.invalidatedFeed, true);
  assert.deepEqual(stored, []);

  const retainedReset = new Promise<ActivityFlushResult>((resolve) => {
    outbox.subscribe((outcome) => resolve(outcome));
  });
  const retained = await retainedReset;
  assert.equal(retained.invalidatedFeed, true);
  assert.equal((retained as ActivityFlushResult & { feedVersion?: string }).feedVersion, '2');
});

test('durable outbox shares a single network flush and keeps events after an offline failure', async () => {
  let stored = [event(1, 'github_open')];
  let sends = 0;
  let release: ((value: InteractionBatchResultV2) => void) | undefined;
  const response = new Promise<InteractionBatchResultV2>((resolve) => { release = resolve; });

  const outbox = new DurableActivityOutbox({
    load: async () => [...stored],
    persist: async (events) => { stored = [...events]; },
    prepare,
    send: async () => {
      sends += 1;
      return response;
    },
  });

  const first = outbox.flush('token');
  const second = outbox.flush('token');
  assert.equal(first, second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sends, 1);
  assert.equal(stored.length, 1);

  release?.(acknowledgement(stored));
  await first;
  assert.deepEqual(stored, []);

  stored = [event(2, 'github_open')];
  const offline = new DurableActivityOutbox({
    load: async () => [...stored],
    persist: async (events) => { stored = [...events]; },
    prepare,
    send: async () => { throw new Error('offline'); },
  });
  await assert.rejects(offline.flush('token'), /offline/);
  assert.deepEqual(stored.map((queued) => queued.event_id), [event(2).event_id]);
});

test('partial acknowledgement removes only confirmed event IDs', async () => {
  const initial = [event(1, 'like'), event(2, 'share'), event(3, 'dwell')];
  let stored = [...initial];
  const outbox = new DurableActivityOutbox({
    load: async () => [...stored],
    persist: async (events) => { stored = [...events]; },
    prepare,
    send: async () => ({
      accepted: 1,
      duplicates: 0,
      feed_version: '2',
      results: [{ event_id: initial[0].event_id, status: 'accepted' }],
    }),
  });

  await assert.rejects(outbox.flush('token'), /only acknowledged part/);
  assert.deepEqual(
    stored.map((queued) => queued.event_id),
    [initial[1].event_id, initial[2].event_id],
  );
});

test('a flush delivers its starting snapshot and retains events queued during delivery', async () => {
  let stored = [event(1, 'like')];
  let release!: () => void;
  let started!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const response = new Promise<void>((resolve) => { release = resolve; });
  const sent: string[][] = [];
  const outbox = new DurableActivityOutbox({
    load: async () => [...stored],
    persist: async (events) => { stored = [...events]; },
    prepare,
    send: async (batch) => {
      sent.push(batch.map((item) => item.event_id));
      started();
      await response;
      return acknowledgement(batch);
    },
  });
  const first = outbox.flush('token');
  await sending;
  await outbox.enqueue(event(2, 'dwell'));
  release();
  const result = await first;
  assert.equal(result.delivered, 1);
  assert.deepEqual(sent, [[event(1).event_id]]);
  assert.deepEqual(stored.map((item) => item.event_id), [event(2).event_id]);
  assert.equal(await outbox.pendingCount(), 1);
  await outbox.flush('token');
  assert.deepEqual(stored, []);
});
