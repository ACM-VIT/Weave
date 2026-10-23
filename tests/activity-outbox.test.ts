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
  assert.deepEqual(result.acknowledgedActivities?.map((queued) => queued.event_id), initial.map((queued) => queued.event_id));
  assert.deepEqual(stored, []);

  const retainedReset = new Promise<ActivityFlushResult>((resolve) => {
    outbox.subscribe((outcome) => resolve(outcome));
  });
  const retained = await retainedReset;
  assert.equal(retained.invalidatedFeed, true);
  assert.equal((retained as ActivityFlushResult & { feedVersion?: string }).feedVersion, '2');
  assert.deepEqual(retained.acknowledgedActivities?.map((queued) => queued.event_id), initial.map((queued) => queued.event_id));
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

for (const mode of ['snapshot', 'append'] as const) test(`failed initial storage read retains exact prepared impression before later actions (${mode})`, async () => {
  let unavailable = true, generation = 1;
  const prior = event(90), first = { ...event(91), serve_id: '00000000-0000-4000-8000-888888888888', position: 0, client_occurred_at: '2026-10-24T00:00:01.123Z' };
  const action = { ...event(92, 'like'), repo_id: first.repo_id, serve_id: first.serve_id, position: first.position,
    client_occurred_at: '2026-10-24T00:00:02.456Z', impression_event_id: first.event_id };
  const bytes = JSON.stringify(first);
  let stored = [prior]; const sent: QueuedActivity[] = [];
  const persistence = mode === 'snapshot' ? {
    persist: async (events: readonly QueuedActivity[]) => { stored = structuredClone([...events]); },
  } : {
    append: async (event: QueuedActivity) => { stored.push(structuredClone(event)); },
    acknowledge: async (ids: ReadonlySet<string>) => { stored = stored.filter(event => !ids.has(event.event_id)); },
  };
  const outbox = new DurableActivityOutbox({
    ...persistence,
    load: async () => { if (unavailable) throw new Error('initial storage import unavailable'); return structuredClone(stored); },
    prepare,
    session: { capture: () => generation, assertCurrent: (token, expected) => {
      if (token !== 'owner-a' || expected !== generation) throw new Error('account lease changed');
    } },
    send: async batch => {
      for (const row of batch) assert.ok(stored.some(saved => JSON.stringify(saved) === JSON.stringify(row)), 'every exact event must be durable before delivery');
      sent.push(...batch); return acknowledgement(batch);
    },
  });
  await assert.rejects(outbox.enqueue(first), /initial storage import unavailable/);
  assert.deepEqual(stored, [prior]);
  generation = 2;
  await assert.rejects(outbox.flush('owner-b', generation), /account lease changed/);
  assert.deepEqual(sent, [], 'a different account cannot retry the original event');
  unavailable = false;
  // Storage recovery alone must allow the periodic flush to retry the original,
  // without requiring a second visibility event or an additional enqueue.
  const recovered = await outbox.flush('owner-a', generation);
  assert.equal(recovered.delivered, 2);
  assert.deepEqual(sent.map(row => row.event_id), [prior.event_id, first.event_id]);
  assert.equal(JSON.stringify(sent[1]), bytes, 'initial UUID, time and payload remain exact');
  await outbox.enqueue(action);
  await outbox.flush('owner-a', generation);
  assert.equal(sent[2].impression_event_id, first.event_id);
  assert.equal(sent.filter(row => row.event_id === first.event_id).length, 1);
});
