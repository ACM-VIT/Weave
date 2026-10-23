import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { requestTelemetry } from '../../middlewares/requestTelemetryMiddleware.js';
import { withOutboxTrace } from '../../observability/tracing.js';

test('HTTP response exposes server parent while preserving independent request ID', async () => {
  const app = express();
  app.use(requestTelemetry);
  app.get('/', (_req, res) => res.json(withOutboxTrace({})));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {
      headers: { 'x-request-id': 'legacy-correlation-id',
        traceparent: '00-11111111111111111111111111111111-1111111111111111-01' },
    });
    assert.equal(response.headers.get('x-request-id'), 'legacy-correlation-id');
    const trace = response.headers.get('traceparent');
    assert.match(trace!, /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    assert.notEqual(trace!.split('-')[1], '11111111111111111111111111111111');
    assert.deepEqual(await response.json(), { _traceparent: trace });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});


test('outbox capture discards supplied reserved metadata without a server context', () => {
  const payload = { job_id: 'unchanged', _traceparent: 'externally-supplied' };
  assert.deepEqual(withOutboxTrace(payload), { job_id: 'unchanged' });
  assert.equal(payload._traceparent, 'externally-supplied');
});
