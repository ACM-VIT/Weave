import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
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
import { REPOSITORIES, RepositoryData } from '@/data/repositories';
import { RepositoryFeedItem } from '@/components/home/RepositoryFeedItem';
import { FeedHeader } from '@/components/home/FeedHeader';
import { REFERENCE_THEME } from '@/constants/theme';
import { AUTH_BYPASS_ENABLED } from '@/constants/auth';
import { useInfiniteQuery } from '@tanstack/react-query';
import * as SecureStore from '../../utils/storage';
import { fetchFeed } from '@/api/feed';
import {
  prepareQueuedActivity,
  sendBatchedActivity,
  type FeedbackAction,
  type QueuedActivity,
} from '@/api/activity';
import { useAuth } from '@/store/AuthContext';
import { loadActivityOutbox, persistActivityOutbox } from '@/services/activityOutboxStorage';

const WEB_FEED_LIST_STYLE =
  Platform.OS === 'web'
    ? ({ overflowY: 'auto', scrollSnapType: 'y mandatory' } as ViewStyle)
    : null;
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 50 } as const;
const ACTIVITY_FLUSH_INTERVAL_MS = 8_000;
const ACTIVITY_RETRY_MAX_MS = 60_000;

// Helper to map backend ML JSON to the frontend RepositoryData format
function mapBackendToFrontend(backendItem: any): RepositoryData {
  const repoFullName =
    backendItem.full_name ||
    backendItem.github_repo ||
    backendItem.repo_id ||
    backendItem.id ||
    '';
  const [owner = 'unknown', title = 'repo'] = repoFullName.includes('/') ? repoFullName.split('/') : ['unknown', 'repo'];
  const rawLanguages = backendItem.languages ?? backendItem.language_used ?? [];
  const techStack = Array.isArray(rawLanguages)
    ? rawLanguages.map((language) =>
        typeof language === 'string' ? language : language?.name
      ).filter(Boolean)
    : Object.keys(rawLanguages || {});

  return {
    id: backendItem.repo_id || repoFullName || Math.random().toString(),
    serveId: backendItem.serve_id ?? null,
    feedPosition: backendItem.position ?? null,
    viewerReaction: backendItem.viewer_reaction === 'like' || backendItem.viewer_reaction === 'dislike'
      ? backendItem.viewer_reaction : null,
    viewerSaved: backendItem.viewer_saved === true,
    title,
    owner,
    ownerUserId: typeof backendItem.owner_user_id === 'string'
      ? backendItem.owner_user_id
      : null,
    viewerFollowsOwner: typeof backendItem.viewer_follows_owner === 'boolean'
      ? backendItem.viewer_follows_owner
      : null,
    description: backendItem.description || '',
    readmeSummary: backendItem.readme_summary || backendItem.summary || 'No summary available.',
    readmeFull: backendItem.readme_md || backendItem.readme || 'No readme available.',
    stats: {
      stars: (backendItem.star_count ?? 0).toString(),
      views: (backendItem.views_count ?? 0).toString(),
      bugs: (backendItem.open_issues_count ?? backendItem.pr_count ?? 0).toString(),
      forks: (backendItem.fork_count ?? 0).toString(),
      likes: (backendItem.likes_count ?? backendItem.saves_count ?? 0).toString(),
      comments: (backendItem.comments_count ?? backendItem.comment_count ?? 0).toString(),
    },
    updatedText: backendItem.updated_at 
      ? `updated ${new Date(backendItem.updated_at).toLocaleDateString()}` 
      : 'updated recently',
    techStack,
  };
}

export default function HomeScreen() {
  const { user } = useAuth();
  const isPreview = user?.isPreview === true || AUTH_BYPASS_ENABLED;
  const { width, height } = useWindowDimensions();
  const responsiveWidth = getResponsiveContentWidth(width) ?? width;
  const [viewport, setViewport] = useState({
    width: Math.max(Math.min(responsiveWidth, 520), 1),
    height: Math.max(height, 1),
  });
  const pageWidth = viewport.width;
  const pageHeight = viewport.height;
  
  const pendingActivityBatch = useRef<QueuedActivity[]>([]);
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const activityUserIdRef = useRef<string | null>(null);
  const retryDelayRef = useRef(1_000);
  const retryNotBeforeRef = useRef(0);

  const flushActivityBatch = useCallback(async () => {
    if (flushPromiseRef.current) return flushPromiseRef.current;
    const operation = (async () => {
      if (pendingActivityBatch.current.length === 0) return;
      if (Date.now() < retryNotBeforeRef.current) return;
      const token = await SecureStore.getItemAsync('access_token');
      if (!token) return;

      const events = [...pendingActivityBatch.current];
      pendingActivityBatch.current = [];
      const ownerId = activityUserIdRef.current;
      if (ownerId) void persistActivityOutbox(ownerId, pendingActivityBatch.current);
      try {
        await sendBatchedActivity(events, token);
        retryDelayRef.current = 1_000;
        retryNotBeforeRef.current = 0;
      } catch {
        const queuedIds = new Set(pendingActivityBatch.current.map((event) => event.event_id));
        pendingActivityBatch.current = [
          ...events.filter((event) => !queuedIds.has(event.event_id)),
          ...pendingActivityBatch.current,
        ];
        if (ownerId) await persistActivityOutbox(ownerId, pendingActivityBatch.current);
        retryNotBeforeRef.current = Date.now() + retryDelayRef.current;
        retryDelayRef.current = Math.min(ACTIVITY_RETRY_MAX_MS, retryDelayRef.current * 2);
        throw new Error('Activity delivery failed; events remain queued.');
      }
    })();
    flushPromiseRef.current = operation;
    try {
      await operation;
    } finally {
      flushPromiseRef.current = null;
    }
  }, []);

  const fetchFeedPage = async ({ pageParam }: { pageParam: string | null }) => {
    const token = await SecureStore.getItemAsync('access_token');
    if (!token) throw new Error('No token');
    
    // Flush batched activity before fetching the next page
    await flushActivityBatch();
    
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
  } = useInfiniteQuery({
    queryKey: ['feed', user?.user_id],
    queryFn: fetchFeedPage,
    enabled: !isPreview,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: null as string | null,
  });

  const feedItems = useMemo(() => isPreview
    ? REPOSITORIES.map((repository, index) => ({
        feedId: `preview-${repository.id}-${index}`,
        repository,
      }))
    : data?.pages.flatMap((page) => page.items).map((item, index) => ({
        feedId: `${item.repo_id || index}-${index}`,
        repository: mapBackendToFrontend(item),
      })) || [], [data?.pages, isPreview]);

  const feedContextRef = useRef(new Map<string, { serve_id: string | null; position: number | null }>());
  useEffect(() => {
    feedContextRef.current = new Map(feedItems.map(({ repository }) => [repository.id, {
      serve_id: repository.serveId ?? null,
      position: repository.feedPosition ?? null,
    }]));
  }, [feedItems]);

  const handleQueueActivity = useCallback((event: { repo_id: string; action: FeedbackAction; dwell_seconds?: number }, flushNow?: boolean) => {
    if (isPreview) return;

    const context = feedContextRef.current.get(event.repo_id);
    pendingActivityBatch.current.push(prepareQueuedActivity({
      ...event,
      serve_id: context?.serve_id ?? null,
      position: context?.position ?? null,
    }));
    const ownerId = activityUserIdRef.current;
    if (ownerId) void persistActivityOutbox(ownerId, pendingActivityBatch.current);
    
    if (flushNow || pendingActivityBatch.current.length >= 10) {
      void flushActivityBatch().catch(() => undefined);
    }
  }, [flushActivityBatch, isPreview]);

  useEffect(() => {
    if (isPreview || !user?.user_id) return;
    const ownerId = user.user_id;
    let cancelled = false;
    activityUserIdRef.current = ownerId;

    void loadActivityOutbox(ownerId).then((stored) => {
      if (cancelled) return;
      const existingIds = new Set(pendingActivityBatch.current.map((event) => event.event_id));
      pendingActivityBatch.current = [
        ...stored.filter((event) => !existingIds.has(event.event_id)),
        ...pendingActivityBatch.current,
      ];
      void flushActivityBatch().catch(() => undefined);
    });

    const interval = setInterval(() => {
      void flushActivityBatch().catch(() => undefined);
    }, ACTIVITY_FLUSH_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void flushActivityBatch().catch(() => undefined);
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      subscription.remove();
      void persistActivityOutbox(ownerId, pendingActivityBatch.current);
      void flushActivityBatch().catch(() => undefined);
      if (activityUserIdRef.current === ownerId) activityUserIdRef.current = null;
    };
  }, [flushActivityBatch, isPreview, user?.user_id]);

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
        <Pressable style={styles.retryButton} onPress={() => refetch()}>
          <Text style={styles.retryText}>Try again</Text>
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
              isViewable={viewableItems.includes(item.feedId)}
            />
          )}
          style={[styles.feedList, { height: pageHeight }, WEB_FEED_LIST_STYLE]}
          contentContainerStyle={styles.feedListContent}
          showsVerticalScrollIndicator={false}
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
            if (hasNextPage && !isFetchingNextPage) {
              fetchNextPage();
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
