import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { MlFeedbackBatch } from '../../contracts/ml.v2.js';
import { acknowledgedFeedbackIds } from '../../services/mlFeedbackAcknowledgement.js';

test('acknowledgement identity is canonical, bounded, unique and tied to requested events', () => {
  const events = [{ event_id: randomUUID() }] as MlFeedbackBatch['events'];
  const id = events[0]!.event_id;
  const body = { accepted: 1, duplicates: 0, durable: true, acknowledged_event_ids: [id.toUpperCase()] };
  assert.deepEqual([...acknowledgedFeedbackIds(body, events)], [id.toLowerCase()]);
  for (const patch of [{ durable: false }, { accepted: -1 }, { accepted: 1.5 }, { acknowledged_event_ids: [randomUUID()] },
    { accepted: 2, acknowledged_event_ids: [id, id.toUpperCase()] }, { acknowledged_event_ids: [null] }]) {
    assert.throws(() => acknowledgedFeedbackIds({ ...body, ...patch }, events));
  }
  assert.equal(acknowledgedFeedbackIds({ accepted: 0, duplicates: 1, durable: true }, events).size, 1);
});
test('aggregate-only acceptance is compatible for a singleton and ambiguous for a batch', () => {
  const events = [{ event_id: randomUUID() }, { event_id: randomUUID() }] as MlFeedbackBatch['events'];
  assert.throws(() => acknowledgedFeedbackIds({ accepted: 2, duplicates: 0, durable: true }, events), /Ambiguous/);
  assert.throws(() => acknowledgedFeedbackIds({ accepted: 1, duplicates: 0 }, events.slice(0, 1)), /Invalid/);
  assert.throws(() => acknowledgedFeedbackIds({ accepted: true, duplicates: 0, durable: true }, events.slice(0, 1)), /Invalid/);
});
