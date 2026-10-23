import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

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
  assert.throws(() => resolveOutboxLeaseMs({ OUTBOX_LEASE_MS: 'not-a-number' }), /integer between/);
  assert.throws(() => resolveOutboxLeaseMs({
    ML_REPOSITORY_INDEX_TIMEOUT_MS: '-1',
  }), /integer between/);
});

test('outbox lease covers the longest configured durable operation and rejects overflow', () => {
  for (const name of ['ML_DELIVERY_TIMEOUT_MS', 'ML_ONBOARDING_TIMEOUT_MS', 'ML_REPOSITORY_REFRESH_TIMEOUT_MS']) {
    assert.equal(resolveOutboxLeaseMs({ [name]: '400000' }), 460_000);
    assert.throws(() => resolveOutboxLeaseMs({ [name]: '400000', OUTBOX_LEASE_MS: '300000' }), /every ML delivery/);
  }
  assert.throws(() => resolveOutboxLeaseMs({ ML_REPOSITORY_INDEX_TIMEOUT_MS: '2147483647' }), /recovery margin/);
});

test('outbox shutdown grace covers an index request and completion cleanup', () => {
  const unit = readFileSync(new URL('../../deploy/systemd/gh-social-outbox.service', import.meta.url), 'utf8');
  const dockerGrace = Number(unit.match(/^ExecStop=.*docker stop --time (\d+) gh-social-outbox$/m)?.[1]);
  const systemdGrace = Number(unit.match(/^TimeoutStopSec=(\d+)$/m)?.[1]);
  assert.ok(dockerGrace * 1_000 >= resolveOutboxLeaseMs({}), 'Docker must allow the default request and recovery margin.');
  assert.ok(systemdGrace >= dockerGrace + 30, 'Systemd must let Docker finish stopping the worker.');
});
