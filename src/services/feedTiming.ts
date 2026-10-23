import type { FeedPage } from './feedPagination';

const boundsMs = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000];
type Outcome = 'success' | 'empty' | 'rejected' | 'failure' | 'cancelled';
type Stage = 'feed_ready' | 'first_visible' | 'ready_to_visible';
type Mode = 'personalized' | 'discovery' | 'unknown';
export type FeedTiming = Readonly<{
  startedAtMs: number; readyAtMs: number; initialPage: boolean;
  mode: Mode; sampledTraceparent?: string;
}>;
type Histogram = { count: number; sum_ms: number; buckets: number[] };
type Record = { stage: Stage; mode: Mode; outcome: Outcome; duration_ms: number; traceparent?: string };
const histograms = new Map<string, Histogram>();
const records: Record[] = [];
const rendered = new WeakSet<FeedTiming>();
const now = () => performance.now();

function sampledTraceparent(value?: string): string | undefined {
  if (!value || !/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/.test(value)) return;
  const [, trace, span] = value.split('-');
  return /^0+$/.test(trace) || /^0+$/.test(span) ? undefined : value;
}
function observe(stage: Stage, mode: Mode, outcome: Outcome, duration: number, traceparent?: string) {
  if (!Number.isFinite(duration) || duration < 0) return;
  const key = JSON.stringify({ stage, mode, outcome });
  const histogram = histograms.get(key) ?? { count: 0, sum_ms: 0, buckets: boundsMs.map(() => 0) };
  histogram.count++; histogram.sum_ms += duration;
  boundsMs.forEach((bound, index) => { if (duration <= bound) histogram.buckets[index]++; });
  histograms.set(key, histogram);
  // Only a sampled, server-issued context is retained; no product identities.
  if (!traceparent) return;
  if (records.length === 128) records.shift();
  records.push({ stage, mode, outcome, duration_ms: duration, traceparent });
}

/** Decoded Home response readiness includes retries/fallback, not React commit. */
export async function measureFeedLoad(load: () => Promise<FeedPage>, initialPage: boolean,
  clock = now): Promise<FeedPage> {
  const startedAtMs = clock();
  try {
    const { serverTraceparent, ...page } = await load();
    const readyAtMs = clock();
    const mode = page.mode === 'discovery' ? 'discovery' : 'personalized';
    const traceparent = sampledTraceparent(serverTraceparent);
    const timing: FeedTiming = { startedAtMs, readyAtMs, initialPage, mode,
      ...(traceparent ? { sampledTraceparent: traceparent } : {}) };
    observe('feed_ready', mode, page.items.length ? 'success' : 'empty', readyAtMs - startedAtMs, traceparent);
    return { ...page, timing };
  } catch (error) {
    const failure = error as { name?: string; code?: string; status?: number } | null;
    const outcome = failure?.name === 'AbortError' || failure?.code === 'SESSION_CHANGED' ? 'cancelled'
      : failure?.status && failure.status >= 400 && failure.status < 500 ? 'rejected' : 'failure';
    observe('feed_ready', 'unknown', outcome, clock() - startedAtMs);
    throw error;
  }
}

/** First >=50% viewable card for an initial page; not pixel-paint or image-ready. */
export function markFeedFirstVisible(timing?: FeedTiming, clock = now): void {
  if (!timing?.initialPage || rendered.has(timing)) return;
  const visibleAtMs = clock();
  if (!Number.isFinite(visibleAtMs) || visibleAtMs < timing.readyAtMs) return;
  rendered.add(timing);
  observe('first_visible', timing.mode, 'success', visibleAtMs - timing.startedAtMs, timing.sampledTraceparent);
  observe('ready_to_visible', timing.mode, 'success', visibleAtMs - timing.readyAtMs, timing.sampledTraceparent);
}

/** Local, bounded diagnostics; no network export or device/user identifiers. */
export function snapshotFeedTiming() {
  return {
    bounds_ms: [...boundsMs, '+Inf'],
    histograms: Object.fromEntries([...histograms].map(([key, value]) => [key,
      { ...value, buckets: [...value.buckets, value.count] }])),
    spans: records.map(record => ({ ...record })),
  };
}
