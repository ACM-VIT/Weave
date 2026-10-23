import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startSpan, snapshotSpans, withOutboxTrace } from '../../observability/tracing.js';
import { MlV2Client } from '../../services/mlService.js';
import type { OutboxRow, OutboxService } from '../../services/outboxService.js';
import { OutboxWorker } from '../../workers/outboxWorker.js';
import { stopFixtureProcess } from './fixtureProcess.js';

const mlRoot = process.env.WEAVE_ML_TRACING_ROOT;

test('real Node to FastAPI tracing preserves distinct attempts and serialized outbox lineage',
  { skip: !mlRoot, timeout: 45_000 }, async t => {
    assert.ok(mlRoot && path.isAbsolute(mlRoot));
    assert.equal(await readFile(path.join(mlRoot, 'contracts/ml-v2.openapi.json'), 'utf8'),
      await readFile(new URL('../../contracts/ml-v2.openapi.json', import.meta.url), 'utf8'));
    const fixture = fileURLToPath(new URL('./tracingContractServer.py', import.meta.url));
    const child = spawn(process.env.WEAVE_ML_PYTHON ?? path.join(mlRoot, '.venv/bin/python'),
      ['-c', 'import runpy,sys; runpy.run_path(sys.argv[1], run_name="__main__")', fixture], {
        cwd: mlRoot, env: { ...process.env, APP_ENV: 'development',
          QDRANT_URL: 'http://127.0.0.1:9', REDIS_URL: 'redis://127.0.0.1:9',
          INTERNAL_API_SECRET: 'local-tracing-secret', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    t.after(() => stopFixtureProcess(child));
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tracing fixture did not bind.')), 15_000);
      let output = '';
      child.stdout.on('data', chunk => {
        output += String(chunk);
        const match = /CONTRACT_PORT=(\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Tracing fixture exited.')); });
    });
    const origin = `http://127.0.0.1:${port}`;
    const client = new MlV2Client({ baseUrl: origin, internalSecret: 'local-tracing-secret',
      timeoutMs: 5000, deliveryTimeoutMs: 5000, maxResponseBytes: 1_000_000 });
    const event = { event_id: '00000000-0000-4000-8000-000000000008',
      user_id: '00000000-0000-4000-8000-000000000002',
      repo_id: '00000000-0000-4000-8000-000000000003', feedback_version: '1',
      event_type: 'like' as const, dwell_ms: null, occurred_at: '2026-10-23T00:00:00Z' };
    // Fixed trusted fixture parent makes sampled assertions deterministic.
    const root = startSpan('http', 'http_completion', true,
      '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01');
    await root.run(async () => {
      for (let i = 0; i < 2; i++) {
        assert.equal((await client.deliverFeedback({ schema_version: 2, events: [event] })).accepted, true);
      }
    });
    const payload = root.run(() => JSON.parse(JSON.stringify(withOutboxTrace(event))));
    const row: OutboxRow = { outbox_id: event.event_id, job_type: 'feedback', aggregate_id: event.user_id,
      idempotency_key: event.event_id, payload, attempts: 1, created_at: new Date().toISOString(),
      claim_token: '00000000-0000-4000-8000-000000000020' };
    let committed = false;
    const outbox = { markDelivered: async () => { committed = true; return true; } } as unknown as OutboxService;
    assert.equal((await new OutboxWorker(outbox, client).deliverClaimed(row)).accepted, true);
    assert.equal(committed, true);
    root.finish('success');
    const response = await fetch(`${origin}/api/v2/tracing-fixture`, {
      headers: { 'x-internal-secret': 'local-tracing-secret' },
    });
    assert.equal(response.status, 200);
    const report = await response.json() as {
      received: Array<{ trace_id: string; span_id: string; request_id: string }>;
      diagnostics: { spans: Array<{ trace_id: string; span_id: string; parent_span_id: string;
        kind: string; operation: string; stage: string }> };
    };
    assert.equal(report.received.length, 3);
    assert.equal(new Set(report.received.map(item => item.request_id)).size, 3);
    const trace = root.traceparent.split('-')[1];
    const local = snapshotSpans().filter(span => span.trace_id === trace);
    const remote = report.diagnostics.spans.filter(span => span.trace_id === trace);
    const attempts = local.filter(span => span.stage === 'ml_transport');
    assert.equal(attempts.length, 3);
    assert.equal(new Set(attempts.map(span => span.span_id)).size, 3);
    const delivery = local.find(span => span.stage === 'outbox_delivery')!;
    assert.equal(delivery.parent_span_id, root.traceparent.split('-')[2]);
    assert.equal(attempts[2].parent_span_id, delivery.span_id);
    for (const [index, item] of report.received.entries()) {
      assert.equal(item.trace_id, trace);
      assert.match(item.request_id, /^[0-9a-f-]{36}$/);
      assert.notEqual(item.request_id, event.event_id);
      const worker = remote.find(span => span.span_id === item.span_id)!;
      const server = remote.find(span => span.span_id === worker.parent_span_id)!;
      assert.equal(server.kind, 'SERVER');
      assert.equal(server.parent_span_id, attempts[index].span_id);
      assert.equal(server.stage, 'http');
      assert.notEqual(server.span_id, attempts[index].span_id);
    }
    for (const identity of [event.user_id, event.repo_id, event.event_id]) {
      assert.equal(JSON.stringify(remote).includes(identity), false);
    }
  });
