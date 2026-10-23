import crypto from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import { snapshotHistograms, snapshotFeedbackDelivery } from './metrics.js';
import { snapshotSpans } from './tracing.js';

// Existing private Redis only. Fixed keys bound fleet storage even under churn.
const KEYS = Array.from({ length: 16 }, (_, index) => `observability:{worker-telemetry-v1}:${index}`);
const TTL_SECONDS = 60;
const DEADLINE_MS = 1000;
const MAX_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPERATIONS = new Set(['http', 'recommendations', 'search', 'feedback', 'onboard', 'repo_index', 'repo_refresh', 'health', 'other']);
const STAGES = new Set(['http_completion', 'ml_transport', 'outbox_delivery', 'outbox_age', 'other']);
const OUTCOMES = new Set(['success', 'rejected', 'failure', 'timeout', 'cancelled']);
const BOUNDS = ['5', '10', '25', '50', '100', '250', '500', '1000', '1800', '2500', '4000', '5000', '10000', '30000', '60000', '120000', '240000', '+Inf'];
type WorkerRole = 'outbox' | 'feed' | 'maintenance' | 'all';
interface RedisPort {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}
interface Snapshot {
  process_id: string;
  role: WorkerRole;
  captured_at_ms: number;
  stage_duration_ms: ReturnType<typeof snapshotHistograms>;
  trace_spans: ReturnType<typeof snapshotSpans>;
  feedback_delivery?: ReturnType<typeof snapshotFeedbackDelivery>;
}

// Claim/refresh only our own slot; never overwrite another process's live data.
// Owner is the fixed prefix, avoiding any JSON decode inside Redis.
const PUBLISH = `
for i, key in ipairs(KEYS) do
  local value = redis.call('GET', key)
  if value and string.sub(value, 1, 37) == ARGV[1] .. '\\n' then
    redis.call('SET', key, ARGV[1] .. '\\n' .. ARGV[2], 'EX', ARGV[3])
    return i
  end
end
for i, key in ipairs(KEYS) do
  if redis.call('SET', key, ARGV[1] .. '\\n' .. ARGV[2], 'NX', 'EX', ARGV[3]) then return i end
end
return 0`;
const RELEASE = `
for _, key in ipairs(KEYS) do
  local value = redis.call('GET', key)
  if value and string.sub(value, 1, 37) == ARGV[1] .. '\\n' then redis.call('DEL', key) end
end
return 1`;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every(key => expected.includes(key));
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function member(value: unknown, allowed: Set<string>): value is string {
  return typeof value === 'string' && allowed.has(value);
}
function hex(value: unknown, size: number): boolean {
  return typeof value === 'string' && value.length === size && /^[0-9a-f]+$/.test(value) && !/^0+$/.test(value);
}

/** Reject oversized, stale or non-allowlisted Redis data before exposing it. */
export function parseWorkerSnapshot(raw: string, now = Date.now()): Snapshot | null {
  if (Buffer.byteLength(raw) > MAX_BYTES + 37 || !UUID.test(raw.slice(0, 36)) || raw[36] !== '\n') return null;
  try {
    const value: unknown = JSON.parse(raw.slice(37));
    if (!record(value) || !keys(value, ['process_id', 'role', 'captured_at_ms', 'stage_duration_ms', 'trace_spans',
      ...(Object.hasOwn(value, 'feedback_delivery') ? ['feedback_delivery'] : [])])
      || value.process_id !== raw.slice(0, 36) || typeof value.role !== 'string' || !['outbox', 'feed', 'maintenance', 'all'].includes(String(value.role))
      || !nonnegative(value.captured_at_ms) || value.captured_at_ms > now + 5000 || value.captured_at_ms < now - TTL_SECONDS * 1000
      || !record(value.stage_duration_ms) || Object.keys(value.stage_duration_ms).length > 225
      || !Array.isArray(value.trace_spans) || value.trace_spans.length > 256) return null;
    if (Object.hasOwn(value, 'feedback_delivery')) {
      const feedback = value.feedback_delivery;
      if (!record(feedback) || !keys(feedback, ['outbox_feedback_events_per_request', 'outbox_feedback_unacknowledged_total'])
        || !nonnegative(feedback.outbox_feedback_unacknowledged_total) || !Number.isSafeInteger(feedback.outbox_feedback_unacknowledged_total)) return null;
      const distribution = feedback.outbox_feedback_events_per_request;
      if (!record(distribution) || !keys(distribution, ['count', 'p50', 'p95', 'p99', 'max'])
        || !nonnegative(distribution.count) || !Number.isInteger(distribution.count) || distribution.count > 2048) return null;
      let previous = 0;
      for (const name of ['p50', 'p95', 'p99', 'max']) {
        const sample = distribution[name];
        if (!nonnegative(sample) || !Number.isInteger(sample) || sample < previous || sample > 100
          || (distribution.count === 0 && sample !== 0)) return null;
        previous = sample;
      }
    }
    for (const [label, histogram] of Object.entries(value.stage_duration_ms)) {
      const dimensions: unknown = JSON.parse(label);
      if (!record(dimensions) || !keys(dimensions, ['operation', 'stage', 'outcome'])
        || !member(dimensions.operation, OPERATIONS) || !member(dimensions.stage, STAGES) || !member(dimensions.outcome, OUTCOMES)
        || label !== JSON.stringify({ operation: dimensions.operation, stage: dimensions.stage, outcome: dimensions.outcome })
        || !record(histogram) || !keys(histogram, ['count', 'sum', 'buckets'])
        || !nonnegative(histogram.count) || !Number.isSafeInteger(histogram.count) || !nonnegative(histogram.sum)
        || !record(histogram.buckets) || !keys(histogram.buckets, BOUNDS)) return null;
      let previous = 0;
      for (const bound of BOUNDS) {
        const count = histogram.buckets[bound];
        if (!nonnegative(count) || !Number.isSafeInteger(count) || count < previous || count > histogram.count) return null;
        previous = count;
      }
      if (previous !== histogram.count) return null;
    }
    for (const span of value.trace_spans) {
      if (!record(span) || !keys(span, ['trace_id', 'span_id', 'operation', 'stage', 'outcome', 'duration_ms', 'ended_at_ms',
        ...(Object.hasOwn(span, 'parent_span_id') ? ['parent_span_id'] : [])])
        || !hex(span.trace_id, 32) || !hex(span.span_id, 16)
        || (Object.hasOwn(span, 'parent_span_id') && !hex(span.parent_span_id, 16))
        || !member(span.operation, OPERATIONS) || !member(span.stage, STAGES) || !member(span.outcome, OUTCOMES)
        || !nonnegative(span.duration_ms) || !nonnegative(span.ended_at_ms)
        || Buffer.byteLength(JSON.stringify(span)) > 512) return null;
    }
    return value as unknown as Snapshot;
  } catch { return null; }
}

async function deadline<T>(work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.catch(() => undefined), new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), DEADLINE_MS);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}

export class WorkerTelemetryPublisher {
  private readonly owner = crypto.randomUUID();
  private pending?: Promise<unknown>;
  private stopped = false;
  private previousStatus = '';
  constructor(private readonly redis: RedisPort, private readonly role: WorkerRole) {}

  async publish(): Promise<void> {
    if (this.stopped || this.pending) return;
    const snapshot: Snapshot = { process_id: this.owner, role: this.role, captured_at_ms: Date.now(),
      stage_duration_ms: snapshotHistograms(), trace_spans: snapshotSpans(), feedback_delivery: snapshotFeedbackDelivery() };
    const payload = JSON.stringify(snapshot);
    if (Buffer.byteLength(payload) > MAX_BYTES) {
      if (this.previousStatus !== 'snapshot_too_large') console.warn('[WorkerTelemetry] snapshot_too_large');
      this.previousStatus = 'snapshot_too_large';
      return;
    }
    // Hold the overlap guard until the real Redis operation settles, not timeout.
    const pending = Promise.resolve().then(() => this.redis.eval(PUBLISH, KEYS.length, ...KEYS, this.owner, payload, TTL_SECONDS));
    this.pending = pending;
    void pending.then(() => { this.pending = undefined; }, () => { this.pending = undefined; });
    const result = await deadline(pending);
    const status = result === 0 ? 'capacity_exhausted' : result === undefined ? 'unavailable' : 'ok';
    if (status !== this.previousStatus && status !== 'ok') console.warn(`[WorkerTelemetry] ${status}`);
    this.previousStatus = status;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Never overlap release with an unresolved publish. If Redis stays blocked,
    // leave cleanup to TTL instead of queuing another command during shutdown.
    if (this.pending) {
      await deadline(this.pending);
      if (this.pending !== undefined) return;
    }
    await deadline(Promise.resolve().then(() => this.redis.eval(RELEASE, KEYS.length, ...KEYS, this.owner)));
  }
}

let pendingRead: Promise<(string | null)[]> | undefined;
export async function readWorkerTelemetry(redis: RedisPort) {
  if (!pendingRead) {
    const pending = Promise.resolve().then(() => redis.mget(...KEYS));
    pendingRead = pending;
    void pending.then(() => { pendingRead = undefined; }, () => { pendingRead = undefined; });
  }
  const rows = await deadline(pendingRead);
  if (!rows) return { status: 'unavailable', snapshots: [], slots: KEYS.length };
  const snapshots: Snapshot[] = [];
  let invalidOrStale = 0;
  let occupied = 0;
  for (const raw of rows) {
    if (raw === null) continue;
    occupied++;
    const snapshot = parseWorkerSnapshot(raw);
    if (snapshot) snapshots.push(snapshot); else invalidOrStale++;
  }
  return { status: invalidOrStale ? 'partial' : snapshots.length ? 'ok' : 'empty', snapshots,
    slots: KEYS.length, occupied, capacity_exhausted: occupied === KEYS.length, invalid_or_stale: invalidOrStale };
}
