import crypto from 'node:crypto';

function positiveInteger(name, fallback, maximum) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function percentile(sorted, percentage) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentage) - 1)];
}

const baseUrl = (process.env.LOAD_BASE_URL ?? '').replace(/\/+$/, '');
const confirmedBaseUrl = (process.env.LOAD_CONFIRM_BASE_URL ?? '').replace(/\/+$/, '');
const token = process.env.LOAD_AUTH_TOKEN ?? '';
if (!baseUrl || !token) throw new Error('LOAD_BASE_URL and LOAD_AUTH_TOKEN are required.');
if (confirmedBaseUrl !== baseUrl) {
  throw new Error('Set LOAD_CONFIRM_BASE_URL to the exact LOAD_BASE_URL after reviewing the target.');
}
const parsedBaseUrl = new URL(baseUrl);
if (parsedBaseUrl.protocol !== 'https:' && parsedBaseUrl.hostname !== '127.0.0.1'
  && parsedBaseUrl.hostname !== 'localhost') {
  throw new Error('Remote load-test targets must use HTTPS.');
}

const concurrency = positiveInteger('LOAD_CONCURRENCY', 10, 200);
const durationSeconds = positiveInteger('LOAD_DURATION_SECONDS', 30, 600);
const p95LimitMs = positiveInteger('LOAD_P95_LIMIT_MS', 1_500, 60_000);
const maximumErrorPercent = Number(process.env.LOAD_MAX_ERROR_PERCENT ?? '1');
if (!Number.isFinite(maximumErrorPercent) || maximumErrorPercent < 0 || maximumErrorPercent > 100) {
  throw new Error('LOAD_MAX_ERROR_PERCENT must be from 0 to 100.');
}

const deadline = Date.now() + durationSeconds * 1_000;
const latencies = [];
const statusCounts = new Map();
let successful = 0;
let failed = 0;
let empty = 0;

async function worker() {
  const sessionId = crypto.randomUUID();
  while (Date.now() < deadline) {
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}/v2/feed`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          feed_request_id: crypto.randomUUID(),
          session_id: sessionId,
          limit: 10,
          cursor: null,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const latency = performance.now() - started;
      latencies.push(latency);
      statusCounts.set(response.status, (statusCounts.get(response.status) ?? 0) + 1);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || !Array.isArray(payload.items)) {
        failed += 1;
      } else {
        successful += 1;
        if (payload.items.length === 0) empty += 1;
      }
    } catch {
      latencies.push(performance.now() - started);
      statusCounts.set('network', (statusCounts.get('network') ?? 0) + 1);
      failed += 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
latencies.sort((a, b) => a - b);
const requests = successful + failed;
const errorPercent = requests === 0 ? 100 : (failed / requests) * 100;
const report = {
  target_origin: parsedBaseUrl.origin,
  concurrency,
  duration_seconds: durationSeconds,
  requests,
  successful,
  failed,
  empty,
  requests_per_second: Number((requests / durationSeconds).toFixed(2)),
  error_percent: Number(errorPercent.toFixed(3)),
  latency_ms: {
    p50: Number(percentile(latencies, 0.5).toFixed(2)),
    p95: Number(percentile(latencies, 0.95).toFixed(2)),
    p99: Number(percentile(latencies, 0.99).toFixed(2)),
    max: Number((latencies.at(-1) ?? 0).toFixed(2)),
  },
  status_counts: Object.fromEntries([...statusCounts].map(([key, value]) => [String(key), value])),
};
console.log(JSON.stringify(report, null, 2));

if (requests === 0 || empty > 0 || errorPercent > maximumErrorPercent
  || report.latency_ms.p95 > p95LimitMs) {
  process.exitCode = 1;
}
