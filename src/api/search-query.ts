import type { SearchGroup, SearchPage } from '../models/search';
import { infiniteQueryOptions } from '@tanstack/react-query';

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

export function isSearchExpired(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 410);
}

export function searchQueryOptions(input: {
  viewer: string | undefined; query: string; group: SearchGroup; searchId: string;
  composing: boolean; offline: boolean;
  send: (cursor: string | null, signal: AbortSignal) => Promise<SearchPage>;
}) {
  return infiniteQueryOptions({
    queryKey: ['explore-search', input.viewer, input.query, input.group, input.composing, input.searchId],
    enabled: input.query.length >= MIN_SEARCH_LENGTH && !input.composing && !input.offline && Boolean(input.viewer),
    queryFn: ({ pageParam, signal }) => runSearchRequest(signal, pageParam ? 0 : SEARCH_DEBOUNCE_MS,
      activeSignal => input.send(pageParam, activeSignal)),
    initialPageParam: null as string | null,
    getNextPageParam: (page: SearchPage) => page.next_cursor ?? undefined,
    retry: false,
    staleTime: 30_000,
  });
}
