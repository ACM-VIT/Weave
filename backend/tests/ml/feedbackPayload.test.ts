import assert from 'node:assert/strict';
import test from 'node:test';

import type { InteractionEventV2 } from '../../contracts/interactions.v2.js';
import { buildMlFeedbackEvent } from '../../services/mlFeedbackPayloadService.js';

test('feedback payload canonicalizes an accepted offset timestamp to UTC', () => {
  const event: InteractionEventV2 = {
    event_id: '00000000-0000-4000-8000-000000000001',
    schema_version: 2,
    session_id: '00000000-0000-4000-8000-000000000002',
    serve_id: null,
    repo_id: '00000000-0000-4000-8000-000000000003',
    position: null,
    event_type: 'like',
    dwell_ms: null,
    client_occurred_at: '2026-07-21T08:30:00+05:30',
    context: {},
  };
  const payload = buildMlFeedbackEvent(
    '00000000-0000-4000-8000-000000000004', event, '7',
  );
  assert.equal(payload.occurred_at, '2026-07-21T03:00:00.000Z');
  assert.equal(payload.feedback_version, '7');
});


for (const event_type of ['impression', 'follow', 'unfollow'] as const) test(`${event_type} cannot be constructed as online ML feedback`, () => {
  assert.throws(() => buildMlFeedbackEvent('00000000-0000-4000-8000-000000000004', {
    event_id: '00000000-0000-4000-8000-000000000001', schema_version: 2,
    session_id: '00000000-0000-4000-8000-000000000002', serve_id: null,
    repo_id: '00000000-0000-4000-8000-000000000003', position: null,
    event_type, dwell_ms: null,
    client_occurred_at: '2026-10-23T00:00:00Z', context: {},
  }, '1'), /backend telemetry/);
});
