import type { FeedbackAction } from '@/api/activity';
import type { FeedPage, FeedRepositoryPayload } from '@/api/feed';
import type { RepositoryDetail } from '@/models/repository';
import { mapRepositoryDetail } from '@/utils/repository-mapper';

export type FeedRepositoryTarget = {
  repoId: string;
  serveId?: string | null;
  position?: number | null;
};

export type FeedItemSavedState = {
  repositoryId: string;
  serverSaved: boolean;
  saved: boolean;
};

export function reconcileFeedItemSavedState(
  current: FeedItemSavedState,
  repositoryId: string,
  serverSaved: boolean,
): FeedItemSavedState {
  if (current.repositoryId === repositoryId && current.serverSaved === serverSaved) {
    return current;
  }
  return { repositoryId, serverSaved, saved: serverSaved };
}

type FeedCache = {
  pages: FeedPage[];
  pageParams: unknown[];
};

export function feedQueryKey(viewerUserId: string | null | undefined) {
  return ['feed', viewerUserId ?? null] as const;
}

export function mapFeedRepository(
  backendItem: FeedRepositoryPayload,
): RepositoryDetail | null {
  return mapRepositoryDetail(backendItem);
}

export function getFeedItemIdentity(
  repository: RepositoryDetail,
  fallbackPosition: number,
): string {
  const serveIdentity = repository.serveId ?? 'unserved';
  const positionIdentity = repository.feedPosition ?? fallbackPosition;
  return `${serveIdentity}:${repository.id}:${positionIdentity}`;
}

function matchesTarget(
  repository: FeedRepositoryPayload,
  target: FeedRepositoryTarget,
): boolean {
  if (repository.repo_id !== target.repoId) return false;
  if (target.serveId && repository.serve_id !== target.serveId) return false;
  if (target.position !== null && target.position !== undefined
    && repository.position !== target.position) return false;
  return true;
}

function reactionAfter(
  action: FeedbackAction,
  currentReaction: FeedRepositoryPayload['viewer_reaction'],
): 'like' | 'dislike' | null | undefined {
  if (action === 'like') return 'like';
  if (action === 'dislike') return 'dislike';
  if (action === 'unlike') return currentReaction === 'like' ? null : currentReaction;
  if (action === 'undislike') return currentReaction === 'dislike' ? null : currentReaction;
  return undefined;
}

export function patchFeedReaction<T extends FeedCache>(
  cachedFeed: T | undefined,
  target: FeedRepositoryTarget,
  action: FeedbackAction,
): T | undefined {
  if (!cachedFeed) return cachedFeed;

  let feedChanged = false;
  const pages = cachedFeed.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((repository) => {
      if (!matchesTarget(repository, target)) return repository;
      const previousReaction = repository.viewer_reaction;
      const nextReaction = reactionAfter(action, previousReaction);
      if (nextReaction === undefined) return repository;
      if (previousReaction === nextReaction) return repository;

      const previousLikes = Number(repository.likes_count) || 0;
      const likeDelta = Number(nextReaction === 'like') - Number(previousReaction === 'like');
      pageChanged = true;
      return {
        ...repository,
        viewer_reaction: nextReaction,
        likes_count: Math.max(0, previousLikes + likeDelta),
      };
    });

    if (!pageChanged) return page;
    feedChanged = true;
    return { ...page, items };
  });

  return feedChanged ? { ...cachedFeed, pages } : cachedFeed;
}

export function patchFeedSaved<T extends FeedCache>(
  cachedFeed: T | undefined,
  target: FeedRepositoryTarget,
  saved: boolean,
): T | undefined {
  if (!cachedFeed) return cachedFeed;

  let feedChanged = false;
  const pages = cachedFeed.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((repository) => {
      if (!matchesTarget(repository, target) || repository.viewer_saved === saved) {
        return repository;
      }
      pageChanged = true;
      return { ...repository, viewer_saved: saved };
    });

    if (!pageChanged) return page;
    feedChanged = true;
    return { ...page, items };
  });

  return feedChanged ? { ...cachedFeed, pages } : cachedFeed;
}
