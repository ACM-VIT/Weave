// Run: node_modules/.bin/tsx scripts/measure-tracing.mts [iterations]
// Synthetic local instrumentation/snapshot overhead; no HTTP, Redis or model I/O.
import { performance } from 'node:perf_hooks';
import { startSpan, snapshotSpans } from '../backend/observability/tracing.js';
import { observeStage, snapshotHistograms } from '../backend/observability/metrics.js';
const iterations = Number(process.argv[2] ?? 50000);
if (!Number.isSafeInteger(iterations) || iterations < 100 || iterations > 1000000) {
  throw new Error('iterations must be an integer from 100 to 1000000');
}
let checksum = 0;
function measure(name: string, count: number, run: () => void) {
  const cpu = process.cpuUsage();
  const rss = process.memoryUsage().rss;
  const start = performance.now();
  for (let i = 0; i < count; i++) run();
  const wall_ms = performance.now() - start;
  return { name, count, wall_ms, microseconds_per_iteration: wall_ms * 1000 / count,
    cpu_us: process.cpuUsage(cpu), rss_delta_bytes: process.memoryUsage().rss - rss };
}
// Warm JIT/module paths before measuring; retain default 1/16 sampling.
for (let i = 0; i < 1000; i++) { const span = startSpan('http', 'http_completion', true); span.finish('success'); }
const results = [
  measure('baseline_callback', iterations, () => { checksum++; }),
  measure('root_and_child', iterations, () => {
    const root = startSpan('http', 'http_completion', true);
    root.run(() => { const child = startSpan('recommendations', 'ml_transport'); checksum++; child.finish('success'); });
    root.finish('success');
  }),
  measure('two_family_snapshot_json', 1000, () => {
    checksum += JSON.stringify({ stage_duration_ms: snapshotHistograms(), trace_spans: snapshotSpans() }).length;
  }),
];
const complete = snapshotSpans().filter(span => span.stage === 'http_completion').flatMap(root => {
  const children = snapshotSpans().filter(child => child.parent_span_id === root.span_id && child.trace_id === root.trace_id);
  return children.length === 1 ? [Math.max(0, root.duration_ms - children[0].duration_ms)] : [];
}).sort((a, b) => a - b);
for (const operation of ['http', 'recommendations', 'search', 'feedback', 'onboard', 'repo_index', 'repo_refresh', 'health', 'other']) {
  for (const stage of ['http_completion', 'ml_transport', 'outbox_delivery', 'outbox_age', 'other']) {
    for (const outcome of ['success', 'rejected', 'failure', 'timeout', 'cancelled'] as const) observeStage(operation, stage, outcome, 10);
  }
}
results.push(measure('max_225_family_snapshot_json', 1000, () => {
  checksum += JSON.stringify({ stage_duration_ms: snapshotHistograms(), trace_spans: snapshotSpans() }).length;
}));
console.log(JSON.stringify({ residual: { scope: 'sequential root minus one direct child, synthetic milliseconds only',
  complete_traces: complete.length, p50_ms: complete[Math.floor(complete.length * .5)], p95_ms: complete[Math.floor(complete.length * .95)] }, node: process.version, sampling: 'default 1/16 roots; child inherits',
  scope: 'local sequential microbenchmark; RSS delta noisy, not peak; snapshot is not full operations endpoint or network scrape',
  results, checksum }, null, 2));
