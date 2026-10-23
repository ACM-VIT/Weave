import type { FeedTiming } from './feedTiming';
import { createUuid } from '../utils/uuid';
import { assertFeedRequestActive } from './feedTransport';

export type FeedPage = {
  items: Record<string, unknown>[];
  nextCursor: string | null;
  feedVersion: string;
  mode?: 'personalized' | 'discovery';
  sessionId?: string;
  requestCursor?: string | null;
  serverTraceparent?: string;
  timing?: FeedTiming;
};

type Request = { cursor: string | null; id: string; recovery: boolean; initialCursor: string | null };
const isNewer = (a: string, b: string) => BigInt(a) > BigInt(b);
const isStaleCursor = (error: unknown) => (error as { status?: number })?.status === 400
  && (error as { code?: string })?.code === 'FEED_CURSOR_STALE';

/** Account-scoped presentation state; server cursors and serves remain authoritative. */
export class FeedPaginationController {
  private sessionId = createUuid();
  private seen = new Set<unknown>();
  private committedPages: FeedPage[] = [];
  private version = '0';
  private minimumVersion = '0';
  private stale = false;
  private unversionedRevision = 0;
  private epoch = 0;
  private active: Promise<FeedPage> | null = null;
  private pending: Request | null = null;
  private staged = new WeakMap<AbortSignal, { seen: Set<unknown>; nextCursor: string | null; replacement: boolean; mode: FeedPage['mode'] }>();

  constructor(
    private readonly fetchPage: (cursor: string | null, signal: AbortSignal | undefined, requestId: string, sessionId: string, initialPage: boolean) => Promise<FeedPage>,
    pages: FeedPage[] = [],
    private readonly getCommittedPages?: () => FeedPage[],
  ) {
    const restoredSession = pages.at(-1)?.sessionId;
    if (restoredSession) this.sessionId = restoredSession;
    else if (pages.length) this.stale = true;
    for (const page of pages) {
      for (const item of page.items) this.seen.add(item.repo_id);
      if (isNewer(page.feedVersion, this.version)) this.version = page.feedVersion;
    }
    this.committedPages = pages;
  }

  /** Release evicted query pages and their deduplication IDs after each commit. */
  commitPages(pages: FeedPage[]) {
    this.committedHistory(pages);
  }

  markStale(version?: string) {
    if (version && (!isNewer(version, this.version) || !isNewer(version, this.minimumVersion))) return;
    if (version) this.minimumVersion = version;
    this.stale = true;
    if (!version) this.unversionedRevision++;
  }

  reset() {
    this.epoch++;
    this.sessionId = createUuid();
    this.seen.clear();
    this.committedPages = [];
    this.version = this.minimumVersion = '0';
    this.stale = false;
    this.unversionedRevision = 0;
    this.pending = null;
    this.active = null;
    this.staged = new WeakMap();
  }

  load(cursor: string | null, signal?: AbortSignal): Promise<FeedPage> {
    if (this.active) return this.active;
    const operation = this.loadInternal(cursor, signal);
    this.active = operation;
    void operation.finally(() => { if (this.active === operation) this.active = null; }).catch(() => {});
    return operation;
  }

  private committedHistory(pages: FeedPage[]): Set<unknown> {
    if (pages !== this.committedPages) {
      // QueryClient pages are immutable. Reuse IDs in the unchanged prefix,
      // but rebuild after replacement/removal so deleted pages leave no IDs.
      let prefix = 0;
      while (prefix < this.committedPages.length && pages[prefix] === this.committedPages[prefix]) prefix++;
      if (prefix < this.committedPages.length) {
        this.seen.clear();
        prefix = 0;
      }
      for (let index = prefix; index < pages.length; index++) {
        for (const item of pages[index].items) this.seen.add(item.repo_id);
      }
      this.committedPages = pages;
    }
    return this.seen;
  }

  private async loadInternal(cursor: string | null, signal?: AbortSignal): Promise<FeedPage> {
    const epoch = this.epoch;
    const check = () => {
      assertFeedRequestActive(signal);
      if (epoch !== this.epoch) throw Object.assign(new Error('Feed session changed.'), { name: 'AbortError' });
    };
    // Infinite queries commit a complete refetch, not individual queryFn results.
    // Keep replacement-page history within that fetch's signal; a later failure
    // or cancellation must not add unseen cards to the committed history.
    const committed = this.getCommittedPages?.();
    const previous = committed && signal && cursor !== null ? this.staged.get(signal) : undefined;
    const staged = previous?.nextCursor === cursor ? previous : undefined;
    const replacement = cursor === null || Boolean(staged?.replacement)
      || Boolean(committed?.length && committed[0].requestCursor === cursor);
    const committedSeen = committed && !replacement ? this.committedHistory(committed) : undefined;
    const seen = staged?.seen ?? (committed ? new Set<unknown>() : this.seen);
    const hasHistory = () => seen.size > 0 || Boolean(committedSeen?.size);
    // Catalogue offsets are independent of personalized feed versions.
    const catalogueRequest = cursor?.startsWith('discovery:') === true;
    // A restart at null is still continuation recovery when loaded pages remain.
    // Only an actual first-page/refetch request may switch the browsing source.
    const continuationMode = cursor === null ? undefined
      : staged?.mode ?? (committed ?? this.committedPages)[0]?.mode ?? (catalogueRequest ? 'discovery' : 'personalized');
    const recoverStale = this.stale && !catalogueRequest;
    let request = this.pending;
    if (!request || (recoverStale && !request.recovery) || request.initialCursor !== cursor) {
      request = { cursor: recoverStale ? null : cursor, id: createUuid(), recovery: recoverStale && hasHistory(), initialCursor: cursor };
    }
    let restarted = request.recovery;
    let duplicatePages = 0;
    const visitedCursors = new Set<string | null>();
    for (;;) {
      check();
      const revision = this.unversionedRevision;
      this.pending = request;
      try {
        // A continuation's internal cursor restart does not replace Home's first page.
        const page = await this.fetchPage(request.cursor, signal, request.id, this.sessionId, cursor === null);
        check();
        if (continuationMode && (page.mode ?? 'personalized') !== continuationMode) {
          throw Object.assign(new Error('Personalized recommendations are unavailable. Try again or refresh Home.'), {
            status: 503, code: 'PERSONALIZED_FEED_UNAVAILABLE',
          });
        }
        if (page.mode !== 'discovery' && (revision !== this.unversionedRevision || isNewer(this.minimumVersion, page.feedVersion))) {
          throw Object.assign(new Error('Recommendations changed. Try loading more again.'), { status: 400, code: 'FEED_CURSOR_STALE' });
        }
        const items = page.items.filter((item) => {
          const id = item.repo_id;
          if (committedSeen?.has(id) || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        this.version = page.feedVersion;
        this.stale = false;
        if (items.length === 0 && page.nextCursor !== null) {
          visitedCursors.add(request.cursor);
          if (visitedCursors.has(page.nextCursor)) {
            throw new Error('No new repositories are available yet. Try again shortly.');
          }
          request = { ...request, cursor: page.nextCursor, id: createUuid() };
          this.pending = request;
          if (++duplicatePages >= 5) throw new Error('No new repositories are available yet. Try again shortly.');
          continue;
        }
        this.pending = null;
        if (committed && signal) this.staged.set(signal, { seen, nextCursor: page.nextCursor, replacement, mode: page.mode ?? 'personalized' });
        return { ...page, items, requestCursor: cursor };
      } catch (error) {
        check();
        if (catalogueRequest || !isStaleCursor(error)) throw error;
        this.stale = true;
        this.pending = null;
        if (restarted) throw error;
        restarted = true;
        request = { cursor: null, id: createUuid(), recovery: hasHistory(), initialCursor: cursor };
      }
    }
  }
}
