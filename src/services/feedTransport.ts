export type FeedRequest = {
  feed_request_id: string;
  session_id: string;
  limit: number;
  cursor: string | null;
  readme_mode?: 'inline' | 'deferred';
};

export function assertFeedRequestActive(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('Feed request cancelled.'), { name: 'AbortError' });
}

export function waitForFeedRetry(ms: number, signal?: AbortSignal): Promise<void> {
  assertFeedRequestActive(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(Object.assign(new Error('Feed request cancelled.'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export async function requestFeedWithRetry<T>(
  body: FeedRequest,
  send: (body: FeedRequest, signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  wait = waitForFeedRetry,
  retryUnavailable = true,
): Promise<T> {
  let attempt = 0;
  let requestBody = body;
  let inlineFallbackAttempted = false;
  for (;;) {
    assertFeedRequestActive(signal);
    try {
      const result = await send(requestBody, signal);
      assertFeedRequestActive(signal);
      return result;
    } catch (error) {
      assertFeedRequestActive(signal);
      const failure = error as { status?: number; name?: string; code?: string; retryAfter?: string | null };
      const preCommitReadmeRejection = failure.name !== 'AbortError' && failure.code !== 'SESSION_CHANGED'
        && ((failure.status === 409 && failure.code === 'FEED_README_MEDIA_UNAVAILABLE')
          || (failure.status === 400 && failure.code === 'INVALID_FEED_README_MODE'));
      if (!inlineFallbackAttempted && body.readme_mode === 'deferred' && preCommitReadmeRejection) {
        inlineFallbackAttempted = true;
        requestBody = { ...body, readme_mode: 'inline' };
        continue;
      }
      const retryable = failure.name !== 'AbortError' && failure.code !== 'SESSION_CHANGED'
        && (error instanceof TypeError || failure.status === 408 || failure.status === 409
          || failure.status === 425 || failure.status === 429 || (failure.status ?? 0) >= 500);
      if ((!retryUnavailable && failure.code === 'PERSONALIZED_FEED_UNAVAILABLE') || !retryable || attempt >= 2) throw error;
      const header = failure.retryAfter;
      const seconds = header && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN;
      const retryAt = header ? Date.parse(header) : NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000
        : Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now())
          : failure.status === 409 ? 1000 : 500 * 2 ** attempt;
      await wait(delay, signal);
      attempt++;
    }
  }
}
