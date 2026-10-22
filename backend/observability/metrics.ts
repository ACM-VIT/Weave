const counters = new Map<string, number>();
const samples = new Map<string, number[]>();

export function incrementMetric(name: string, labels: Record<string, string> = {}): void {
  const key = `${name}:${JSON.stringify(Object.entries(labels).sort())}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function observeMetric(name: string, value: number, labels: Record<string, string> = {}): void {
  const key = `${name}:${JSON.stringify(Object.entries(labels).sort())}`;
  const values = samples.get(key) ?? [];
  values.push(value);
  if (values.length > 2_048) values.shift();
  samples.set(key, values);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

export function snapshotMetrics(): Record<string, unknown> {
  return {
    counters: Object.fromEntries(counters),
    stage_duration_ms: snapshotHistograms(),
    distributions: Object.fromEntries([...samples.entries()].map(([key, values]) => [key, {
      count: values.length, p50: percentile(values, 0.50), p95: percentile(values, 0.95),
      p99: percentile(values, 0.99), max: values.length ? Math.max(...values) : 0,
    }])),
  };
}

export type StageOutcome = 'success' | 'rejected' | 'failure' | 'timeout' | 'cancelled';
const stageOperations = new Set(['http', 'recommendations', 'search', 'feedback', 'onboard', 'repo_index', 'repo_refresh', 'health', 'other']);
const stageNames = new Set(['http_completion', 'ml_transport', 'outbox_delivery', 'outbox_age', 'other']);
const stageOutcomes = new Set(['success', 'rejected', 'failure', 'timeout', 'cancelled']);
const bucketsMs = [5, 10, 25, 50, 100, 250, 500, 1000, 1800, 2500, 4000, 5000, 10000, 30000, 60000, 120000, 240000];
const histograms = new Map<string, { count: number; sum: number; buckets: number[] }>();

/** Fixed 9 operations x 5 stages x 5 outcomes, independent of request data. */
export function observeStage(operation: string, stage: string, outcome: StageOutcome, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const key = JSON.stringify({
    operation: stageOperations.has(operation) ? operation : 'other',
    stage: stageNames.has(stage) ? stage : 'other',
    outcome: stageOutcomes.has(outcome) ? outcome : 'failure',
  });
  const histogram = histograms.get(key) ?? { count: 0, sum: 0, buckets: bucketsMs.map(() => 0) };
  histogram.count++;
  histogram.sum += durationMs;
  bucketsMs.forEach((bound, index) => { if (durationMs <= bound) histogram.buckets[index]++; });
  histograms.set(key, histogram);
}

export function snapshotHistograms(): Record<string, { count: number; sum: number; buckets: Record<string, number> }> {
  return Object.fromEntries([...histograms].map(([key, value]) => [key, {
    count: value.count, sum: value.sum,
    buckets: { ...Object.fromEntries(bucketsMs.map((bound, index) => [String(bound), value.buckets[index]])), '+Inf': value.count },
  }]));
}
