import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';

const mlRoot = process.env.WEAVE_ML_INGESTION_ROOT;

test('Python ingestion batches satisfy the registered HTTP UTF-8 byte/count contract', {
  skip: !mlRoot, timeout: 60_000,
}, async () => {
  assert.ok(mlRoot && path.isAbsolute(mlRoot), 'Select an explicit ML checkout.');
  const previous = { ...process.env };
  // The router imports the lazy SQL adapter. No real database is needed or allowed:
  // replace only its persistence boundary, keeping parser/auth/controller validation.
  process.env.DATABASE_URL = 'postgresql://wire:wire@127.0.0.1:9/weave_wire_contract';
  process.env.INTERNAL_API_SECRET = 'ingestion-wire-contract-secret';
  delete process.env.INTERNAL_API_SECRET_PREVIOUS;
  process.env.DB_SCHEMA_V2_WRITES = 'true';
  const { PostgresRepositoryPersistence } = await import('../../adapters/postgresRepositoryPersistence.js');
  const { sqlClient } = await import('../../db/index.js');
  const { default: router } = await import('../../routes/ingestionRoutes.js');
  const { scopedJsonBodyParser, jsonBodyLimitLabel } = await import('../../middlewares/scopedJsonBodyMiddleware.js');
  const original = PostgresRepositoryPersistence.prototype.bulkUpsert;
  const accepted: unknown[] = [];
  let requests = 0;
  PostgresRepositoryPersistence.prototype.bulkUpsert = async function (repositories) {
    accepted.push(repositories.map(item => ({
      github_id: item.github_id,
      readme_hash: createHash('sha256').update(item.readme ?? '').digest('hex'),
      readme_source_path: item.readme_source_path,
      readme_default_branch: item.readme_default_branch,
      readme_base_url: item.readme_base_url,
    })));
    return repositories.map(item => ({ github_id: item.github_id, repo_id: randomUUID(),
      content_version: 1, changed: true }));
  };
  const app = express();
  app.use((req, _res, next) => { if (req.method === 'POST') requests++; next(); });
  app.use(scopedJsonBodyParser);
  app.use('/api/internal/v2/ingestion', router);
  app.post('/api/v2/wire-test', (_req, res) => res.status(204).end());
  app.get('/wire-test-stats', (_req, res) => res.json({ requests, accepted }));
  const errors: ErrorRequestHandler = (error, req, res, next) => {
    if (error.type !== 'entity.too.large') { next(error); return; }
    res.status(413).json({ error: `Request payload exceeds ${jsonBodyLimitLabel(req)}.` });
  };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { stdout } = await promisify(execFile)(path.join(mlRoot, '.venv/bin/python'), [
      path.resolve('tests/fixtures/ingestionWireClient.py'), origin, mlRoot,
    ], { timeout: 45_000, killSignal: 'SIGKILL', maxBuffer: 1_000_000,
      env: { ...process.env, PYTHONNOUSERSITE: '1' } });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.byte_boundaries, [8_388_607, 8_388_608, 8_388_609]);
    assert.deepEqual(result.record_boundaries, [100, 101]);
    assert.equal(result.non_retryable_413_attempts, 1);
    assert.equal(result.oversized_record_isolated, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    PostgresRepositoryPersistence.prototype.bulkUpsert = original;
    await sqlClient.end({ timeout: 0 });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
