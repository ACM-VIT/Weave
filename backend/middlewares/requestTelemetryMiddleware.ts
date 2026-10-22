import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { incrementMetric, observeMetric } from '../observability/metrics.js';
import { startSpan, httpOutcome } from '../observability/tracing.js';

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// Only literal mounts and Express route templates, never req.path/originalUrl.
// Active routers register literal templates; params remain :names, not values.
const mounts = new Set(['', '/api/auth', '/api/v2', '/api/internal/v2/ingestion', '/api/internal/v2/operations']);
export function requestTelemetry(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header('x-request-id');
  // Preserve the legacy response-only ID contract; never store it as trace data.
  const requestId = supplied && supplied.length <= 128 ? supplied : crypto.randomUUID();
  const started = process.hrtime.bigint();
  // Never adopt a public caller's trace identity or sampling decision.
  const span = startSpan('http', 'http_completion', true);
  res.setHeader('x-request-id', requestId);
  let completed = false;
  const finish = (closed: boolean) => {
    if (completed) return;
    completed = true;
    const outcome = closed && !res.writableFinished ? 'cancelled' : httpOutcome(res.statusCode);
    span.finish(outcome);
    // Keep legacy completed-response counts/distributions, not cancelled sockets.
    if (outcome === 'cancelled') return;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const template = req.route?.path;
    const route = typeof template === 'string' && mounts.has(req.baseUrl) ? `${req.baseUrl}${template}` : 'other';
    const method = methods.has(req.method) ? req.method : 'OTHER';
    const labels = { method, route, status: String(res.statusCode) };
    incrementMetric('http_requests_total', labels);
    observeMetric('http_request_duration_ms', elapsedMs, { method, route });
  };
  res.once('finish', () => finish(false));
  res.once('close', () => finish(true));
  span.run(next);
}
