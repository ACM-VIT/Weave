import { createUuid } from '../utils/uuid';
import { assertFeedRequestActive } from './feedTransport';

export type FeedPage = {
  items: Record<string, unknown>[];
  nextCursor: string | null;
  feedVersion: string;
  sessionId?: string;
};

type Request = { cursor: string | null; id: string; recovery: boolean; initialCursor: string | null };
const isNewer = (a: string, b: string) => BigInt(a) > BigInt(b);
const isStaleCursor = (error: unknown) => (error as { status?: number })?.status === 400
  && (error as { code?: string })?.code === 'FEED_CURSOR_STALE';

/** Account-scoped presentation state; server cursors and serves remain authoritative. */
export class FeedPaginationController {
  private sessionId = createUuid();
  private seen = new Set<unknown>();
  private version = '0';
  private minimumVersion = '0';
  private stale = false;
  private unversionedRevision = 0;
  private epoch = 0;
  private active: Promise<FeedPage> | null = null;
  private pending: Request | null = null;
  private staged = new WeakMap<AbortSignal, { seen: Set<unknown>; nextCursor: string | null }>();

  constructor(
    private readonly fetchPage: (cursor: string | null, signal: AbortSignal | undefined, requestId: string, sessionId: string) => Promise<FeedPage>,
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
    const staged = committed && signal && cursor !== null ? this.staged.get(signal) : undefined;
    const seen = committed
      ? new Set(staged?.nextCursor === cursor ? staged.seen
        : (cursor === null ? [] : committed.flatMap(page => page.items.map(item => item.repo_id))))
      : this.seen;
    let request = this.pending;
    if (!request || (this.stale && !request.recovery) || request.initialCursor !== cursor) {
      request = { cursor: this.stale ? null : cursor, id: createUuid(), recovery: this.stale && seen.size > 0, initialCursor: cursor };
    }
    let restarted = request.recovery;
    let duplicatePages = 0;
    const visitedCursors = new Set<string | null>();
    for (;;) {
      check();
      const revision = this.unversionedRevision;
      this.pending = request;
      try {
        const page = await this.fetchPage(request.cursor, signal, request.id, this.sessionId);
        check();
        if (revision !== this.unversionedRevision || isNewer(this.minimumVersion, page.feedVersion)) {
          throw Object.assign(new Error('Recommendations changed. Try loading more again.'), { status: 400, code: 'FEED_CURSOR_STALE' });
        }
        const items = page.items.filter((item) => {
          if (seen.has(item.repo_id)) return false;
          seen.add(item.repo_id);
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
        if (committed && signal) this.staged.set(signal, { seen, nextCursor: page.nextCursor });
        return { ...page, items };
      } catch (error) {
        check();
        if (!isStaleCursor(error)) throw error;
        this.stale = true;
        this.pending = null;
        if (restarted) throw error;
        restarted = true;
        request = { cursor: null, id: createUuid(), recovery: seen.size > 0, initialCursor: cursor };
      }
    }
  }
}
