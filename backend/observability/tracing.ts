import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { observeStage, type StageOutcome } from './metrics.js';

const operations = new Set(['http', 'recommendations', 'search', 'feedback', 'onboard', 'repo_index', 'repo_refresh', 'health', 'model_operation', 'model_withdrawal', 'model_status', 'model_authority', 'other']);
const stages = new Set(['http_completion', 'ml_transport', 'outbox_delivery']);
interface Context { traceId: string; spanId: string; sampled: boolean }
interface SpanRecord {
  trace_id: string; span_id: string; parent_span_id?: string;
  operation: string; stage: string; outcome: StageOutcome;
  duration_ms: number; ended_at_ms: number;
}
function randomId(bytes: number): string {
  let value: string;
  do { value = crypto.randomBytes(bytes).toString('hex'); } while (/^0+$/.test(value));
  return value;
}
const context = new AsyncLocalStorage<Context>();
// At most 256 records, each <=512 UTF-8 JSON bytes, plus fixed object overhead.
const records: SpanRecord[] = [];
export function snapshotSpans(): SpanRecord[] { return records.map(record => ({ ...record })); }

function parseTraceparent(raw: unknown): Context | undefined {
  if (typeof raw !== 'string') return;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/.exec(raw);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return;
  return { traceId: match[1], spanId: match[2], sampled: match[3] === '01' };
}

/** Capture only server-owned ALS context; metadata stays internal to the outbox. */
export function withOutboxTrace<T extends object>(payload: T): T & { _traceparent?: string } {
  const current = context.getStore();
  const { _traceparent, ...dto } = payload as T & { _traceparent?: unknown };
  return { ...dto, ...(current ? { _traceparent:
    `00-${current.traceId}-${current.spanId}-${current.sampled ? '01' : '00'}` } : {}) } as T & { _traceparent?: string };
}

export function withoutOutboxTrace(payload: Record<string, unknown>): Record<string, unknown> {
  const { _traceparent, ...dto } = payload;
  return dto;
}

export function startSpan(operation: string, stage: string, root = false, durableParent?: unknown) {
  const parent = durableParent !== undefined ? parseTraceparent(durableParent) : root ? undefined : context.getStore();
  const traceId = parent?.traceId ?? randomId(16);
  const value: Context = {
    traceId, spanId: randomId(8),
    sampled: parent?.sampled ?? (Number.parseInt(traceId.slice(0, 2), 16) < 16),
  };
  const safeOperation = operations.has(operation) ? operation : 'other';
  const safeStage = stages.has(stage) ? stage : 'other';
  const started = performance.now();
  let finished = false;
  return {
    traceparent: `00-${value.traceId}-${value.spanId}-${value.sampled ? '01' : '00'}`,
    run<T>(work: () => T): T { return context.run(value, work); },
    finish(outcome: StageOutcome) {
      if (finished) return;
      finished = true;
      const duration = Math.max(0, performance.now() - started);
      observeStage(safeOperation, safeStage, outcome, duration);
      if (!value.sampled) return;
      const record: SpanRecord = {
        trace_id: value.traceId, span_id: value.spanId,
        ...(parent ? { parent_span_id: parent.spanId } : {}),
        operation: safeOperation, stage: safeStage, outcome,
        duration_ms: duration, ended_at_ms: Date.now(),
      };
      if (Buffer.byteLength(JSON.stringify(record)) > 512) return;
      if (records.length === 256) records.shift();
      records.push(record);
    },
  };
}

export function httpOutcome(status: number): StageOutcome {
  return status === 408 || status === 504 ? 'timeout'
    : status >= 200 && status < 400 ? 'success'
    : status >= 400 && status < 500 ? 'rejected' : 'failure';
}

export function mlOperation(path: string): string {
  const paths: Record<string, string> = {
    '/api/v2/recommendations/generate': 'recommendations', '/api/v2/search/repositories': 'search',
    '/api/v2/feedback/batch': 'feedback', '/api/v2/users/onboard': 'onboard',
    '/api/v2/repositories/embed': 'repo_index', '/api/v2/repositories/refresh': 'repo_refresh',
    '/api/v2/health': 'health',
    '/api/v2/model-operations': 'model_operation', '/api/v2/model-operation-withdrawals': 'model_withdrawal',
    '/api/v2/model-operation-status': 'model_status', '/api/v2/model-authority': 'model_authority',
  };
  return Object.hasOwn(paths, path) ? paths[path] : 'other';
}
