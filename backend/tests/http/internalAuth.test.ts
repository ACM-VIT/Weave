import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { requireInternalSecret } from '../../middlewares/internalAuthMiddleware.js';

async function request(secret: string | undefined): Promise<number> {
  const app = express();
  app.post('/internal', requireInternalSecret, (_req, res) => res.status(204).end());
  app.use((_error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).end());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    return (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/internal`, {
      method: 'POST', headers: secret === undefined ? {} : { 'x-internal-secret': secret },
    })).status;
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('malformed Unicode secrets fail closed without a timingSafeEqual byte-length exception', async () => {
  const current = process.env.INTERNAL_API_SECRET; const previous = process.env.INTERNAL_API_SECRET_PREVIOUS;
  process.env.INTERNAL_API_SECRET = 'abcd'; delete process.env.INTERNAL_API_SECRET_PREVIOUS;
  try {
    assert.equal(await request('éabc'), 401);
    assert.equal(await request('ééab'), 401);
    assert.equal(await request('abcd'), 204);
    assert.equal(await request(undefined), 401);
  } finally {
    if (current === undefined) delete process.env.INTERNAL_API_SECRET; else process.env.INTERNAL_API_SECRET = current;
    if (previous === undefined) delete process.env.INTERNAL_API_SECRET_PREVIOUS; else process.env.INTERNAL_API_SECRET_PREVIOUS = previous;
  }
});

test('current and previous secrets remain valid during rotation and absent configuration remains unavailable', async () => {
  const current = process.env.INTERNAL_API_SECRET; const previous = process.env.INTERNAL_API_SECRET_PREVIOUS;
  process.env.INTERNAL_API_SECRET = 'abcd'; process.env.INTERNAL_API_SECRET_PREVIOUS = 'old-secret';
  try {
    assert.equal(await request('abcd'), 204); assert.equal(await request('old-secret'), 204);
    assert.equal(await request('wrong'), 401);
    process.env.INTERNAL_API_SECRET_PREVIOUS = 'clé';
    assert.equal(await request('clé'), 204);
    delete process.env.INTERNAL_API_SECRET; delete process.env.INTERNAL_API_SECRET_PREVIOUS;
    assert.equal(await request('abcd'), 503);
  } finally {
    if (current === undefined) delete process.env.INTERNAL_API_SECRET; else process.env.INTERNAL_API_SECRET = current;
    if (previous === undefined) delete process.env.INTERNAL_API_SECRET_PREVIOUS; else process.env.INTERNAL_API_SECRET_PREVIOUS = previous;
  }
});
