import { throwIfAborted } from '../utils/abort-signal';
import type { SearchGroup, SearchPage } from '../models/search';
import { infiniteQueryOptions } from '@tanstack/react-query';

/** Abort both the debounce timer and transport when the observer is superseded. */
export async function runSearchRequest<T>(signal: AbortSignal, delay: number, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  throwIfAborted(signal);
  if (delay) await new Promise<void>((resolve,reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Search cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve(); },delay);
    signal.addEventListener('abort',abort,{ once: true });
  });
  throwIfAborted(signal);
  const result = await send(signal);
  throwIfAborted(signal);
  return result;
}
export const MIN_SEARCH_LENGTH = 2;
export const SEARCH_DEBOUNCE_MS = 300;

/** A typing deadline is shared across renders, but explicit actions never wait. */
export class SearchRequestTiming {
  private notBefore = 0;
  constructor(private readonly now: () => number = Date.now) {}
  typed(): void { this.notBefore = this.now() + SEARCH_DEBOUNCE_MS; }
  explicit(): void { this.notBefore = 0; }
  delay(): number { return Math.max(0, this.notBefore - this.now()); }
}

/** Reuse cached searches across group/query changes; only an explicit restart rotates an ID. */
export class SearchSessions {
  private readonly ids = new Map<string, string>();
  constructor(private readonly createId: () => string) {}
  get(viewer: string | undefined, query: string, group: SearchGroup, restart = false): string {
    const key = JSON.stringify([viewer, query.trim(), group]);
    if (restart || !this.ids.has(key)) this.ids.set(key, this.createId());
    return this.ids.get(key)!;
  }
}

export function isSearchExpired(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 410);
}

export function searchQueryOptions(input: {
  viewer: string | undefined; query: string; group: SearchGroup; searchId: string;
  composing: boolean; offline: boolean; timing?: SearchRequestTiming;
  send: (cursor: string | null, signal: AbortSignal) => Promise<SearchPage>;
}) {
  return infiniteQueryOptions({
    queryKey: ['explore-search', input.viewer, input.query, input.group, input.composing, input.searchId],
    enabled: input.query.length >= MIN_SEARCH_LENGTH && !input.composing && !input.offline && Boolean(input.viewer),
    queryFn: ({ pageParam, signal }) => runSearchRequest(signal, pageParam ? 0 : (input.timing?.delay() ?? 0),
      activeSignal => input.send(pageParam, activeSignal)),
    initialPageParam: null as string | null,
    getNextPageParam: (page: SearchPage) => page.next_cursor ?? undefined,
    retry: false,
    staleTime: 30_000,
  });
}
