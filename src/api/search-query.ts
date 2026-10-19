/** Abort both the debounce timer and transport when the observer is superseded. */
export async function runSearchRequest<T>(signal: AbortSignal, delay: number, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (delay) await new Promise<void>((resolve,reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Search cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve(); },delay);
    signal.addEventListener('abort',abort,{ once: true });
  });
  signal.throwIfAborted();
  const result = await send(signal);
  signal.throwIfAborted();
  return result;
}
export const MIN_SEARCH_LENGTH = 2;
export const SEARCH_DEBOUNCE_MS = 300;
