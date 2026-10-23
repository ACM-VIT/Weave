import assert from 'node:assert/strict';
import test from 'node:test';
import { OutboxService } from '../../services/outboxService.js';

test('outbox admission rejects invalid limits and job filters before opening a database connection', async () => {
  const outbox = new OutboxService();
  for (const limit of [0, -1, 1001, 1.5, Number.NaN]) await assert.rejects(outbox.claim(limit), /claim limit/);
  await assert.rejects(outbox.claim(1, undefined, { jobTypes: [] }), /valid job types/);
  await assert.rejects(outbox.claim(1, undefined, { jobTypes: ['unexpected' as 'feedback'] }), /valid job types/);
  await assert.rejects(outbox.claim(1, undefined, { attempts: 'unexpected' as 'first' }), /attempt filter/);
});
