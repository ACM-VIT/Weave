import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveOutboxLeaseMs, retryDelayMs } from '../../services/outboxService.js';

test('outbox retry uses capped full jitter', () => {
  assert.equal(retryDelayMs(0, () => 0.5), 500);
  assert.equal(retryDelayMs(3, () => 0.5), 4_000);
  assert.equal(retryDelayMs(30, () => 1), 900_000);
});

test('outbox lease always exceeds the repository-index timeout by a recovery margin', () => {
  assert.equal(resolveOutboxLeaseMs({}), 300_000);
  assert.equal(resolveOutboxLeaseMs({ ML_REPOSITORY_INDEX_TIMEOUT_MS: '300000' }), 360_000);
  assert.equal(resolveOutboxLeaseMs({
    ML_REPOSITORY_INDEX_TIMEOUT_MS: '240000', OUTBOX_LEASE_MS: '420000',
  }), 420_000);
  assert.throws(() => resolveOutboxLeaseMs({
    ML_REPOSITORY_INDEX_TIMEOUT_MS: '240000', OUTBOX_LEASE_MS: '299999',
  }), /at least 60 seconds longer/);
  assert.throws(() => resolveOutboxLeaseMs({ OUTBOX_LEASE_MS: 'not-a-number' }), /positive integer/);
  assert.throws(() => resolveOutboxLeaseMs({
    ML_REPOSITORY_INDEX_TIMEOUT_MS: '-1',
  }), /positive integer/);
});
