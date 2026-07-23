import assert from 'node:assert/strict';
import test from 'node:test';

import { applyOutboxReadinessGate, getOutboxDeadLimit } from '../../runtime/outboxReadiness.js';

const status = {
  pending: 0,
  claimed: 0,
  delivered: 12,
  dead: 1,
  superseded: 2,
  oldest_pending_seconds: 0,
};

test('production readiness rejects any dead outbox row by default', () => {
  assert.equal(getOutboxDeadLimit({ NODE_ENV: 'production' }), 0);
  assert.equal(applyOutboxReadinessGate(status, { NODE_ENV: 'production' }).healthy, false);
});

test('an explicit non-negative dead-row limit overrides the environment default', () => {
  assert.equal(getOutboxDeadLimit({ NODE_ENV: 'production', OUTBOX_MAX_DEAD: '2' }), 2);
  assert.equal(
    applyOutboxReadinessGate(status, { NODE_ENV: 'production', OUTBOX_MAX_DEAD: '2' }).healthy,
    true,
  );
});

test('invalid limits stay permissive outside production', () => {
  assert.equal(getOutboxDeadLimit({ NODE_ENV: 'development', OUTBOX_MAX_DEAD: '-1' }), Number.MAX_SAFE_INTEGER);
  assert.equal(getOutboxDeadLimit({ NODE_ENV: 'development', OUTBOX_MAX_DEAD: '' }), Number.MAX_SAFE_INTEGER);
  assert.equal(applyOutboxReadinessGate(status, { NODE_ENV: 'test' }).healthy, true);
});
