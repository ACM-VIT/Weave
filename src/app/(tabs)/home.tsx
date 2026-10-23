import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import { getResponsiveContentWidth } from '@/components/responsive-layout';
import type { RepositoryData } from '@/data/repositories';
import { RepositoryFeedItem } from '@/components/home/RepositoryFeedItem';
import { FeedHeader } from '@/components/home/FeedHeader';
import { REFERENCE_THEME } from '@/constants/theme';
import { router, type Href } from 'expo-router';
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import * as SecureStore from '../../utils/storage';
import { fetchHomeFeed } from '@/api/home-feed';
import { subscribeToHomeFeedInvalidations } from '@/utils/home-feed';
import { type ActivityInput } from '@/api/activity';
import { useAuth } from '@/store/AuthContext';
import { getActivityOutbox } from '@/services/activityOutboxClient';
import {
  feedQueryKey as getFeedQueryKey,
  mapFeedRepository,
  patchFeedReaction,
  patchFeedSaved,
} from '@/utils/feed-repository';
import { repositoryHref } from '@/utils/repository-links';
import { FeedPaginationController, type FeedPage } from '@/services/feedPagination';
import { authSessionLifecycle } from '@/api/session-lifecycle';
import { createFeedItemMapper } from '@/utils/feed-items';
import NetInfo from '@react-native-community/netinfo';
import { startActivityOutboxLifecycle } from '@/services/activityOutboxLifecycle';

const WEB_FEED_LIST_STYLE =
  Platform.OS === 'web'
    ? ({ overflowY: 'auto', scrollSnapType: 'y mandatory' } as ViewStyle)
    : null;
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 50 } as const;
const ACTIVITY_FLUSH_INTERVAL_MS = 8_000;

export default function HomeScreen() {
  const { user, checkOnboardingStatus } = useAuth();
  const queryClient = useQueryClient();
  const feedQueryKey = useMemo(() => getFeedQueryKey(user?.user_id), [user?.user_id]);
  const listRef = useRef<FlatList<{ feedId: string; repository: RepositoryData }> | null>(null);
  const pagination = useMemo(() => {
    const controller = new FeedPaginationController(async (cursor, signal, requestId, sessionId) => {
      const token = await SecureStore.getItemAsync('access_token');
      if (!token) throw new Error('No token');
      return fetchHomeFeed(token, cursor, { signal, requestId, sessionId });
    }, queryClient.getQueryData<InfiniteData<FeedPage>>(feedQueryKey)?.pages,
    () => queryClient.getQueryData<InfiniteData<FeedPage>>(feedQueryKey)?.pages ?? []);
    return { controller, reset: () => controller.reset() };
  }, [feedQueryKey, queryClient]);
  useEffect(() => subscribeToHomeFeedInvalidations(queryClient, feedQueryKey, () => pagination.controller.markStale()), [queryClient, feedQueryKey, pagination]);
  const activityOutbox = user?.user_id
    ? getActivityOutbox(user.user_id)
    : null;
  const { width, height } = useWindowDimensions();
  const responsiveWidth = getResponsiveContentWidth(width) ?? width;
  const [viewport, setViewport] = useState({
    width: Math.max(Math.min(responsiveWidth, 520), 1),
    height: Math.max(height, 1),
  });
  const pageWidth = viewport.width;
  const pageHeight = viewport.height;

  
  const flushActivityBatch = useCallback(async () => {
    if (!activityOutbox) return { delivered: 0, invalidatedFeed: false, deferred: false };
    const generation = authSessionLifecycle.currentGeneration();
    const token = await SecureStore.getItemAsync('access_token');
    authSessionLifecycle.assertCurrent(generation);
    if (!token) return { delivered: 0, invalidatedFeed: false, deferred: true };
    return activityOutbox.flush(token, generation);
  }, [activityOutbox]);


  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isFetching,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useInfiniteQuery({
    queryKey: feedQueryKey,
    queryFn: ({ pageParam, signal }) => pagination.controller.load(pageParam, signal),
    retry: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: Boolean(user?.user_id),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: null as string | null,
  });

  const feedProjection = useMemo(() => ({
    queryKey: feedQueryKey,
    mapPages: createFeedItemMapper(mapFeedRepository),
  }), [feedQueryKey]);
  const feedItems = useMemo(() => {
    return feedProjection.mapPages(data?.pages);
  }, [data?.pages, feedProjection]);

  const handleQueueActivity = useCallback((event: ActivityInput, flushNow?: boolean) => {
    queryClient.setQueryData<InfiniteData<FeedPage, string | null>>(
      feedQueryKey,
      (cachedFeed) => patchFeedReaction(cachedFeed, {
        repoId: event.repo_id,
        serveId: event.serve_id,
        position: event.position,
      }, event.action),
    );
    if (!activityOutbox) return;

    const generation = authSessionLifecycle.currentGeneration();
    void activityOutbox.enqueue(event).then(async () => {
      if (!authSessionLifecycle.isCurrent(generation)) return;
      if (flushNow || await activityOutbox.pendingCount() >= 10) {
        await flushActivityBatch();
      }
    }).catch(() => undefined);
  }, [activityOutbox, feedQueryKey, flushActivityBatch, queryClient]);

  const handleSavedChange = useCallback((
    repository: RepositoryData,
    saved: boolean,
    saveStateChanged: boolean,
  ) => {
    if (saveStateChanged) pagination.controller.markStale();
    queryClient.setQueryData<InfiniteData<FeedPage, string | null>>(
      feedQueryKey,
      (cachedFeed) => patchFeedSaved(cachedFeed, {
        repoId: repository.id,
        serveId: repository.serveId,
        position: repository.feedPosition,
      }, saved),
    );
  }, [feedQueryKey, queryClient, pagination]);

  const openOwnerProfile = useCallback((repository: RepositoryData) => {
    const normalizedOwner = repository.owner.trim().toLocaleLowerCase();
    const viewerGithubHandle = typeof user?.github_handle === 'string'
      ? user.github_handle.trim().toLocaleLowerCase()
      : '';
    const claimedOwnerUserId = repository.ownerProfileClaimedUserId ?? repository.ownerUserId;
    const isViewerOwner = claimedOwnerUserId === user?.user_id
      || (!claimedOwnerUserId && Boolean(viewerGithubHandle) && normalizedOwner === viewerGithubHandle);

    if (isViewerOwner) {
      router.push('/(tabs)/profile');
      return;
    }

    router.push({
      pathname: '/user/[username]',
      params: {
        username: repository.owner,
        ...(repository.ownerUserId ? { userId: repository.ownerUserId } : {}),
        ...(repository.ownerProfileId ? { profileId: repository.ownerProfileId } : {}),
        ...(repository.ownerBio ? { bio: repository.ownerBio } : {}),
        isFollowing: String(repository.viewerFollowsOwner === true),
        followStateKnown: String(typeof repository.viewerFollowsOwner === 'boolean'),
      },
    } as unknown as Href);
  }, [user]);

  useEffect(() => {
    if (!activityOutbox) return;
    const generation = authSessionLifecycle.currentGeneration();
    const unsubscribe = activityOutbox.subscribe(({ invalidatedFeed, feedVersion }) => {
      if (!invalidatedFeed || !authSessionLifecycle.isCurrent(generation)) return;
      pagination.controller.markStale(feedVersion);
      void checkOnboardingStatus().catch(() => undefined);
    });
    const stopLifecycle = startActivityOutboxLifecycle({
      flush: flushActivityBatch,
      intervalMs: ACTIVITY_FLUSH_INTERVAL_MS,
      subscribeAppState: listener => {
        const subscription = AppState.addEventListener('change', listener);
        return () => subscription.remove();
      },
      subscribeConnectivity: listener => NetInfo.addEventListener(listener),
    });

    return () => {
      stopLifecycle();
      unsubscribe();
    };
  }, [activityOutbox, checkOnboardingStatus, flushActivityBatch, pagination]);

  const [viewableItems, setViewableItems] = useState<string[]>([]);
  const onViewableItemsChanged = useCallback(({ viewableItems }: any) => {
    setViewableItems(viewableItems.map((v: any) => v.item.feedId));
  }, []);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.max(event.nativeEvent.layout.height, 1);
    const nextWidth = Math.max(
      Math.min(event.nativeEvent.layout.width, responsiveWidth, 520),
      1
    );
    setViewport((current) =>
      current.width === nextWidth && current.height === nextHeight
        ? current
        : { width: nextWidth, height: nextHeight }
    );
  }, [responsiveWidth]);

  const refreshFeed = async () => {
    await queryClient.cancelQueries({ queryKey: feedQueryKey, exact: true });
    pagination.reset();
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    await queryClient.resetQueries({ queryKey: feedQueryKey, exact: true });
  };
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetching) void fetchNextPage({ cancelRefetch: false });
  }, [fetchNextPage, hasNextPage, isFetching]);
  useEffect(() => {
    if (!isFetchNextPageError && feedItems.slice(-3).some(item => viewableItems.includes(item.feedId))) loadMore();
  }, [feedItems, isFetchNextPageError, loadMore, viewableItems]);
  const boundary = (
    <View style={styles.boundary} accessibilityLiveRegion="polite">
      {isFetchNextPageError ? <Pressable accessibilityRole="button" onPress={loadMore} style={styles.boundaryButton}>
          <Text style={styles.retryText}>Couldn&apos;t load more · Retry</Text>
        </Pressable>
          : hasNextPage ? <ActivityIndicator color={REFERENCE_THEME.accent} accessibilityLabel="Loading more repositories" />
            : <Text style={styles.messageBody}>You&apos;ve reached the end · Refresh for more</Text>}
    </View>
  );

  if (isLoading && feedItems.length === 0) {
    return (
      <View style={[styles.outer, styles.centered]} onLayout={handleLayout}>
        <ActivityIndicator size="large" color={REFERENCE_THEME.accent} />
      </View>
    );
  }

  if (isError && feedItems.length === 0) {
    return (
      <View style={[styles.outer, styles.centered, styles.message]} onLayout={handleLayout}>
        <Text style={styles.messageTitle}>Couldn&apos;t load repositories</Text>
        <Text style={styles.messageBody}>
          {error instanceof Error ? error.message : 'The feed service is unavailable.'}
        </Text>
        <Pressable accessibilityRole="button" style={styles.retryButton} onPress={() => refetch()}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityHint="Browse repositories while recommendations are unavailable" style={styles.retryButton} onPress={() => router.push('/(tabs)/explore')}>
          <Text style={styles.retryText}>Explore repositories</Text>
        </Pressable>
      </View>
    );
  }

  if (!isLoading && feedItems.length === 0) {
    return (
      <View style={[styles.outer, styles.centered, styles.message]} onLayout={handleLayout}>
        <Text style={styles.messageTitle}>{data?.pages[0]?.mode === 'discovery' ? 'No repositories available yet' : 'Building your personalized feed'}</Text>
        <Text style={styles.messageBody}>
          {data?.pages[0]?.mode === 'discovery' ? 'The catalogue is empty. Please check again later.' : 'Your onboarding choices were saved. Retry while recommendations are prepared.'}
        </Text>
        <Pressable style={styles.retryButton} onPress={() => refetch()}>
          <Text style={styles.retryText}>Refresh Home</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.outer} onLayout={handleLayout}>
      <View style={[styles.feedShell, { width: pageWidth, height: pageHeight }]}>
        <FlatList
          ref={listRef}
          key={`${pageWidth}-${pageHeight}`}
          data={feedItems}
          keyExtractor={(item) => item.feedId}
          renderItem={({ item, index }) => (
            <RepositoryFeedItem
              repository={item.repository}
              boundary={index === feedItems.length - 1 ? boundary : undefined}
              pageWidth={pageWidth}
              pageHeight={pageHeight}
              onQueueActivity={handleQueueActivity}
              onSavedChange={(saved, changed) => handleSavedChange(item.repository, saved, changed)}
              onOwnerPress={() => openOwnerProfile(item.repository)}
              onRepositoryPress={() => router.push(repositoryHref(item.repository.id))}
              isViewable={viewableItems.includes(item.feedId)}
            />
          )}
          style={[styles.feedList, { height: pageHeight }, WEB_FEED_LIST_STYLE]}
          contentContainerStyle={styles.feedListContent}
          showsVerticalScrollIndicator={false}
          onRefresh={refreshFeed}
          refreshing={isRefetching && !isFetchingNextPage}
          snapToInterval={pageHeight}
          snapToAlignment="start"
          decelerationRate="fast"
          pagingEnabled
          disableIntervalMomentum
          overScrollMode="never"
          getItemLayout={(_, index) => ({
            length: pageHeight,
            offset: pageHeight * index,
            index,
          })}
          onEndReached={() => {
            if (!isFetchNextPageError) loadMore();
          }}
          onEndReachedThreshold={3}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          removeClippedSubviews={false}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={VIEWABILITY_CONFIG}
        />
        <FeedHeader pageWidth={pageWidth} discovery={data?.pages[0]?.mode === 'discovery'} onRefresh={refreshFeed} refreshing={isFetching && !isFetchingNextPage} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: REFERENCE_THEME.canvas,
  },
  centered: {
    justifyContent: 'center',
  },
  message: {
    paddingHorizontal: 32,
  },
  messageTitle: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 20,
    textAlign: 'center',
  },
  messageBody: {
    marginTop: 8,
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-Regular',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 20,
    borderRadius: 10,
    backgroundColor: REFERENCE_THEME.accent,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  retryText: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 14,
  },
  boundary: {
    height: 56, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12,
  },
  boundaryButton: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 10,
    backgroundColor: REFERENCE_THEME.accent,
  },
  feedShell: {
    backgroundColor: REFERENCE_THEME.background,
    overflow: 'hidden',
    position: 'relative',
  },
  feedList: {
    flex: 1,
    width: '100%',
  },
  feedListContent: {
    flexGrow: 0,
  },
});
