import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';

import { requireInternalSecret } from '../../middlewares/internalAuthMiddleware.js';
import {
  canonicalIngestionJsonParser,
  jsonBodyLimitLabel,
  scopedJsonBodyParser,
} from '../../middlewares/scopedJsonBodyMiddleware.js';

async function withBodyLimitServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(scopedJsonBodyParser);
  app.post('/api/v2/echo', (_req, res) => res.status(204).end());
  app.post(
    '/api/internal/v2/ingestion/repositories/upsert',
    requireInternalSecret,
    canonicalIngestionJsonParser,
    (req, res) => res.status(200).json({ parsed_length: String(req.body.padding).length }),
  );
  const bodyError: ErrorRequestHandler = (error, req, res, next) => {
    if ((error as { type?: string }).type !== 'entity.too.large') {
      next(error);
      return;
    }
    res.status(413).json({ error: `Request payload exceeds ${jsonBodyLimitLabel(req)}.` });
  };
  app.use(bodyError);

  const server: Server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('default JSON routes retain 256 KB while authenticated canonical ingestion accepts up to 8 MiB', async () => {
  const previousSecret = process.env.INTERNAL_API_SECRET;
  const previousSecretPrevious = process.env.INTERNAL_API_SECRET_PREVIOUS;
  process.env.INTERNAL_API_SECRET = 'body-limit-test-secret';
  delete process.env.INTERNAL_API_SECRET_PREVIOUS;
  const mediumPadding = 'x'.repeat(300 * 1_024);
  const overIngestionPadding = 'x'.repeat(8 * 1_024 * 1_024);
  const headers = { 'content-type': 'application/json' };
  try {
    await withBodyLimitServer(async (baseUrl) => {
      const defaultResponse = await fetch(`${baseUrl}/api/v2/echo`, {
        method: 'POST', headers, body: JSON.stringify({ padding: mediumPadding }),
      });
      assert.equal(defaultResponse.status, 413);
      assert.deepEqual(await defaultResponse.json(), { error: 'Request payload exceeds 256 KB.' });

      const parsedResponse = await fetch(
        `${baseUrl}/api/internal/v2/ingestion/repositories/upsert`,
        {
          method: 'POST',
          headers: { ...headers, 'x-internal-secret': 'body-limit-test-secret' },
          body: JSON.stringify({ padding: mediumPadding }),
        },
      );
      assert.equal(parsedResponse.status, 200);
      assert.deepEqual(await parsedResponse.json(), { parsed_length: mediumPadding.length });

      const unauthenticated = await fetch(
        `${baseUrl}/api/internal/v2/ingestion/repositories/upsert`,
        { method: 'POST', headers, body: JSON.stringify({ padding: overIngestionPadding }) },
      );
      assert.equal(unauthenticated.status, 401, 'authentication runs before the larger parser');

      const overIngestionResponse = await fetch(
        `${baseUrl}/api/internal/v2/ingestion/repositories/upsert`,
        {
          method: 'POST',
          headers: { ...headers, 'x-internal-secret': 'body-limit-test-secret' },
          body: JSON.stringify({ padding: overIngestionPadding }),
        },
      );
      assert.equal(overIngestionResponse.status, 413);
      assert.deepEqual(await overIngestionResponse.json(), { error: 'Request payload exceeds 8 MiB.' });

      const prefixSpoof = await fetch(`${baseUrl}/api/internal/v2/ingestion-evil`, {
        method: 'POST', headers, body: JSON.stringify({ padding: mediumPadding }),
      });
      assert.equal(prefixSpoof.status, 413, 'a lookalike path must retain the public 256 KB limit');
    });
  } finally {
    if (previousSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previousSecret;
    if (previousSecretPrevious === undefined) delete process.env.INTERNAL_API_SECRET_PREVIOUS;
    else process.env.INTERNAL_API_SECRET_PREVIOUS = previousSecretPrevious;
  }
});
