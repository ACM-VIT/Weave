import { infiniteQueryOptions, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { feedSessions } from '../api/feed-sessions';
import { fetchHomeFeed } from '../api/home-feed';
import { accessTokenOwner } from '../api/access-token-owner';
import { authSessionLifecycle, SessionChangedError } from '../api/session-lifecycle';
import { getStorageItem } from '../utils/storage';
import { feedQueryKey } from '../utils/feed-repository';
import { FeedPaginationController, type FeedPage } from './feedPagination';
import { shareHomeFeedHistory } from './feedHistory';

const controllers = new WeakMap<QueryClient, { viewer: string; generation: number; controller: FeedPaginationController; unsubscribe: () => void }>();

export function homeFeedController(client: QueryClient, viewer: string) {
  const generation = authSessionLifecycle.currentGeneration();
  const existing = controllers.get(client);
  if (existing?.viewer === viewer && existing.generation === generation) return existing.controller;
  if (existing) releaseHomeFeedController(client);
  const key = feedQueryKey(viewer);
  const controller = new FeedPaginationController(async (cursor, signal, requestId, sessionId, initialPage) => {
    const assertCurrent = () => {
      authSessionLifecycle.assertCurrent(generation);
      signal?.throwIfAborted();
    };
    assertCurrent();
    const token = await getStorageItem('access_token');
    assertCurrent();
    if (!token || accessTokenOwner(token) !== viewer) throw new SessionChangedError();
    const canonicalSessionId = await feedSessions(token).prepare(sessionId);
    assertCurrent();
    if (cursor !== null && canonicalSessionId !== sessionId) {
      throw Object.assign(new Error('Browsing session changed.'), {status:400, code:'FEED_CURSOR_STALE'});
    }
    return fetchHomeFeed(token, cursor, { signal, requestId, sessionId:canonicalSessionId, initialPage });
  }, client.getQueryData<InfiniteData<FeedPage>>(key)?.pages,
  () => client.getQueryData<InfiniteData<FeedPage>>(key)?.pages ?? []);
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.type === 'removed' && event.query.queryKey.length === key.length && event.query.queryKey[0] === 'feed' && event.query.queryKey[1] === viewer
      && controllers.get(client)?.controller === controller) releaseHomeFeedController(client);
  });
  controllers.set(client, {viewer, generation, controller, unsubscribe});
  return controller;
}

export function releaseHomeFeedController(client: QueryClient) {
  controllers.get(client)?.unsubscribe();
  controllers.get(client)?.controller.reset();
  controllers.delete(client);
}

export function homeFeedQueryOptions(client: QueryClient, viewer: string) {
  const controller = homeFeedController(client, viewer);
  return infiniteQueryOptions({
    queryKey: feedQueryKey(viewer),
    queryFn: ({pageParam, signal}) => controller.load(pageParam, signal),
    structuralSharing: (previous, next) => shareHomeFeedHistory(previous, next, []),
    initialPageParam: null as string | null,
    getNextPageParam: (page: FeedPage) => page.nextCursor ?? undefined,
    retry: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
