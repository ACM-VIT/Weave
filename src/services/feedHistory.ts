import { type InfiniteData } from '@tanstack/react-query';
import { retainOriginalFeedImpressions } from './feedImpressionAttribution';
import type { FeedPage } from './feedPagination';
import type { FeedItem } from '../utils/feed-items';
import { getFeedItemIdentity } from '../utils/feed-repository';

export const HOME_FEED_HISTORY_LIMIT = 500;

type History = InfiniteData<FeedPage, unknown>;

function identity(item: Record<string, unknown>, index: number): string {
  return getFeedItemIdentity({
    id: String(item.repo_id),
    serveId: typeof item.serve_id === 'string' ? item.serve_id : null,
    feedPosition: typeof item.position === 'number' ? item.position : null,
  }, index);
}

/** Keep newest cards, pinning the visible card if a late response races back-scroll.
 * Empty intermediate pages carry no history; keep the final page's terminal cursor.
 */
export function retainHomeFeedHistory(history: History, visible: readonly string[] = []): History {
  const count = history.pages.reduce((sum, page) => sum + page.items.length, 0);
  const pins = new Set(visible);
  const selected = new Set<number>();
  let index = 0;
  for (const page of history.pages) {
    for (const item of page.items) {
      if (pins.has(identity(item, index))) selected.add(index);
      index++;
    }
  }
  // At most a viewport's cards are pinned by Home. Keep the bound even for a
  // malformed caller supplying more pins than the entire history allowance.
  for (const value of selected) {
    if (selected.size <= HOME_FEED_HISTORY_LIMIT) break;
    selected.delete(value);
  }
  for (let position = count - 1; position >= 0 && selected.size < HOME_FEED_HISTORY_LIMIT; position--) selected.add(position);
  const pages: FeedPage[] = [], pageParams: unknown[] = [];
  index = 0;
  history.pages.forEach((page, pageIndex) => {
    const items = page.items.filter(() => selected.has(index++));
    if (items.length === 0 && pageIndex !== history.pages.length - 1) return;
    pages.push(items.length === page.items.length ? page : { ...page, items });
    pageParams.push(history.pageParams[pageIndex]);
  });
  if (pages.length === history.pages.length && pages.every((page, position) => page === history.pages[position])) return history;
  return { ...history, pages, pageParams };
}

/** Apply the cap before QueryClient publishes either fetched or patched data. */
export function shareHomeFeedHistory(previous: unknown, next: unknown, visible: readonly string[]): unknown {
  if (!next) return next;
  return retainOriginalFeedImpressions(previous, retainHomeFeedHistory(next as History, visible));
}

/** Every row touching the viewport is retained, independent of impression thresholds. */
export function feedViewportIds(items: readonly FeedItem[], offset: number, height: number): string[] {
  if (!items.length || !Number.isFinite(offset) || !Number.isFinite(height) || height <= 0) return [];
  const start = Math.min(items.length - 1, Math.floor(Math.max(0, offset) / height));
  const end = Math.min(items.length, Math.ceil((Math.max(0, offset) + height) / height));
  return items.slice(start, end).map(item => item.feedId);
}

/** Fixed-height cards preserve the visible identity and its fractional offset. */
export function retainedFeedScrollOffset(previous: readonly FeedItem[], next: readonly FeedItem[],
  offset: number, height: number, visible: readonly string[]): number | undefined {
  if (!previous.length || !next.length || height <= 0) return;
  const anchor = visible.find(id => previous.some(item => item.feedId === id))
    ?? previous[Math.min(previous.length - 1, Math.max(0, Math.round(offset / height)))]?.feedId;
  const before = previous.findIndex(item => item.feedId === anchor);
  const after = next.findIndex(item => item.feedId === anchor);
  if (before < 0 || after < 0 || before === after) return;
  return Math.max(0, offset + (after - before) * height);
}
