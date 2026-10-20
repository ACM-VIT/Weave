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
import { fetchFeed, type FeedPage } from '@/api/feed';
import { type ActivityInput } from '@/api/activity';
import { useAuth } from '@/store/AuthContext';
import { getActivityOutbox } from '@/services/activityOutboxClient';
import {
  feedQueryKey as getFeedQueryKey,
  getFeedItemIdentity,
  mapFeedRepository,
  patchFeedReaction,
  patchFeedSaved,
} from '@/utils/feed-repository';
import { repositoryHref } from '@/utils/repository-links';

const WEB_FEED_LIST_STYLE =
  Platform.OS === 'web'
    ? ({ overflowY: 'auto', scrollSnapType: 'y mandatory' } as ViewStyle)
    : null;
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 50 } as const;
const ACTIVITY_FLUSH_INTERVAL_MS = 8_000;

export default function HomeScreen() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const feedQueryKey = useMemo(() => getFeedQueryKey(user?.user_id), [user?.user_id]);
  const feedInvalidationGenerationRef = useRef(0);
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

  useEffect(() => {
    feedInvalidationGenerationRef.current = 0;
  }, [user?.user_id]);
  
  const flushActivityBatch = useCallback(async () => {
    if (!activityOutbox) return { delivered: 0, invalidatedFeed: false, deferred: false };
    const token = await SecureStore.getItemAsync('access_token');
    if (!token) return { delivered: 0, invalidatedFeed: false, deferred: true };
    return activityOutbox.flush(token);
  }, [activityOutbox]);

  const fetchFeedPage = async ({ pageParam }: { pageParam: string | null }) => {
    const token = await SecureStore.getItemAsync('access_token');
    if (!token) throw new Error('No token');
    
    return fetchFeed(token, pageParam);
  };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useInfiniteQuery({
    queryKey: feedQueryKey,
    queryFn: fetchFeedPage,
    enabled: Boolean(user?.user_id),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: null as string | null,
  });

  const feedItems = useMemo(() => {
    return data?.pages
      .flatMap((page) => page.items)
      .map(mapFeedRepository)
      .filter((repository): repository is RepositoryData => repository !== null)
      .map((repository, index) => ({
        feedId: getFeedItemIdentity(repository, index),
        repository,
      })) || [];
  }, [data?.pages]);

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

    void activityOutbox.enqueue(event).then(async () => {
      if (flushNow || await activityOutbox.pendingCount() >= 10) {
        await flushActivityBatch();
      }
    }).catch(() => undefined);
  }, [activityOutbox, feedQueryKey, flushActivityBatch, queryClient]);

  const handleSavedChange = useCallback((
    repository: RepositoryData,
    saved: boolean,
  ) => {
    feedInvalidationGenerationRef.current += 1;
    queryClient.setQueryData<InfiniteData<FeedPage, string | null>>(
      feedQueryKey,
      (cachedFeed) => patchFeedSaved(cachedFeed, {
        repoId: repository.id,
        serveId: repository.serveId,
        position: repository.feedPosition,
      }, saved),
    );
  }, [feedQueryKey, queryClient]);

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
    const unsubscribe = activityOutbox.subscribe(({ invalidatedFeed }) => {
      if (invalidatedFeed) feedInvalidationGenerationRef.current += 1;
    });
    void flushActivityBatch().catch(() => undefined);

    const interval = setInterval(() => {
      void flushActivityBatch().catch(() => undefined);
    }, ACTIVITY_FLUSH_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void flushActivityBatch().catch(() => undefined);
    });

    return () => {
      clearInterval(interval);
      subscription.remove();
      unsubscribe();
    };
  }, [activityOutbox, flushActivityBatch]);

  const handleDeliberateRefresh = useCallback(async () => {
    await flushActivityBatch().catch(() => undefined);
    const generationAtStart = feedInvalidationGenerationRef.current;
    const result = await refetch();
    if (!result.isError
      && feedInvalidationGenerationRef.current === generationAtStart) {
      feedInvalidationGenerationRef.current = 0;
    }
  }, [flushActivityBatch, refetch]);

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
        <Text style={styles.messageTitle}>Couldn&apos;t load your recommendations</Text>
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
        <Text style={styles.messageTitle}>Building your personalized feed</Text>
        <Text style={styles.messageBody}>
          Your onboarding choices were saved. Retry while ML prepares recommendations.
        </Text>
        <Pressable style={styles.retryButton} onPress={() => refetch()}>
          <Text style={styles.retryText}>Load recommendations</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.outer} onLayout={handleLayout}>
      <View style={[styles.feedShell, { width: pageWidth, height: pageHeight }]}>
        <FlatList
          key={`${pageWidth}-${pageHeight}`}
          data={feedItems}
          keyExtractor={(item) => item.feedId}
          renderItem={({ item }) => (
            <RepositoryFeedItem
              repository={item.repository}
              pageWidth={pageWidth}
              pageHeight={pageHeight}
              onQueueActivity={handleQueueActivity}
              onSavedChange={(saved) => handleSavedChange(item.repository, saved)}
              onOwnerPress={() => openOwnerProfile(item.repository)}
              onRepositoryPress={() => router.push(repositoryHref(item.repository.id))}
              isViewable={viewableItems.includes(item.feedId)}
            />
          )}
          style={[styles.feedList, { height: pageHeight }, WEB_FEED_LIST_STYLE]}
          contentContainerStyle={styles.feedListContent}
          showsVerticalScrollIndicator={false}
          onRefresh={handleDeliberateRefresh}
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
            if (hasNextPage
              && !isFetchingNextPage
              && !isRefetching
              && feedInvalidationGenerationRef.current === 0) {
              void flushActivityBatch()
                .then(() => {
                  if (feedInvalidationGenerationRef.current === 0) return fetchNextPage();
                })
                .catch(() => undefined);
            }
          }}
          onEndReachedThreshold={0.75}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          removeClippedSubviews={false}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={VIEWABILITY_CONFIG}
        />
        <FeedHeader pageWidth={pageWidth} />
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
