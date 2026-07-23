import { useState, useCallback, useEffect, useMemo } from 'react';
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
import { DEVELOPMENT_PREVIEW_ENABLED } from '@/config/development-preview';
import { REFERENCE_THEME } from '@/constants/theme';
import { router, type Href } from 'expo-router';
import { DEVELOPMENT_REPOSITORIES } from '@/data/development-repositories';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import * as SecureStore from '../../utils/storage';
import { fetchFeed } from '@/api/feed';
import { type FeedbackAction } from '@/api/activity';
import { useAuth } from '@/store/AuthContext';
import { getActivityOutbox } from '@/services/activityOutboxClient';

const WEB_FEED_LIST_STYLE =
  Platform.OS === 'web'
    ? ({ overflowY: 'auto', scrollSnapType: 'y mandatory' } as ViewStyle)
    : null;
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 50 } as const;
const ACTIVITY_FLUSH_INTERVAL_MS = 8_000;

// Helper to map backend ML JSON to the frontend RepositoryData format
function mapBackendToFrontend(backendItem: any): RepositoryData | null {
  const repoId = typeof backendItem.repo_id === 'string' ? backendItem.repo_id : '';
  const repoFullName = typeof backendItem.full_name === 'string'
    ? backendItem.full_name
    : typeof backendItem.github_repo === 'string'
      ? backendItem.github_repo
      : '';
  const separator = repoFullName.indexOf('/');
  if (!repoId || separator <= 0 || separator === repoFullName.length - 1) return null;
  const owner = repoFullName.slice(0, separator);
  const title = repoFullName.slice(separator + 1);
  const canonicalGithubUrl = `https://github.com/${owner}/${title}`;
  const backendUrl = typeof backendItem.url === 'string'
    ? backendItem.url
    : typeof backendItem.html_url === 'string'
      ? backendItem.html_url
      : '';
  const rawLanguages = backendItem.languages ?? backendItem.language_used ?? [];
  const techStack = Array.isArray(rawLanguages)
    ? rawLanguages.map((language) =>
        typeof language === 'string' ? language : language?.name
      ).filter(Boolean)
    : Object.keys(rawLanguages || {});

  return {
    id: repoId,
    serveId: backendItem.serve_id ?? null,
    feedPosition: backendItem.position ?? null,
    viewerReaction: backendItem.viewer_reaction === 'like' || backendItem.viewer_reaction === 'dislike'
      ? backendItem.viewer_reaction : null,
    viewerSaved: backendItem.viewer_saved === true,
    title,
    owner,
    githubUrl: backendUrl.startsWith('https://github.com/') ? backendUrl : canonicalGithubUrl,
    ownerUserId: typeof backendItem.owner_user_id === 'string'
      ? backendItem.owner_user_id
      : null,
    ownerBio: typeof backendItem.owner_bio === 'string'
      ? backendItem.owner_bio
      : typeof backendItem.owner_profile?.bio === 'string'
        ? backendItem.owner_profile.bio
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
  const { user, checkOnboardingStatus } = useAuth();
  const queryClient = useQueryClient();
  const feedQueryKey = useMemo(() => ['feed', user?.user_id] as const, [user?.user_id]);
  const activityOutbox = user?.user_id && !DEVELOPMENT_PREVIEW_ENABLED
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
  } = useInfiniteQuery({
    queryKey: feedQueryKey,
    queryFn: fetchFeedPage,
    enabled: Boolean(user?.user_id) && !DEVELOPMENT_PREVIEW_ENABLED,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: null as string | null,
  });

  const feedItems = useMemo(() => {
    if (DEVELOPMENT_PREVIEW_ENABLED) {
      return DEVELOPMENT_REPOSITORIES.map((repository, index) => ({
        feedId: `development-${repository.id}-${index}`,
        repository,
      }));
    }
    return data?.pages
      .flatMap((page) => page.items)
      .map(mapBackendToFrontend)
      .filter((repository): repository is RepositoryData => repository !== null)
      .map((repository, index) => ({
        feedId: `${repository.id}-${index}-${repository.viewerReaction ?? 'none'}-${repository.viewerSaved ? 'saved' : 'unsaved'}`,
        repository,
      })) || [];
  }, [data?.pages]);

  const handleQueueActivity = useCallback((event: {
    repo_id: string;
    action: FeedbackAction;
    dwell_seconds?: number;
    serve_id?: string | null;
    position?: number | null;
  }, flushNow?: boolean) => {
    if (!activityOutbox) return;

    void activityOutbox.enqueue(event).then(async () => {
      if (flushNow || await activityOutbox.pendingCount() >= 10) {
        await flushActivityBatch();
      }
    }).catch(() => undefined);
  }, [activityOutbox, flushActivityBatch]);

  const openOwnerProfile = useCallback((repository: RepositoryData) => {
    const normalizedOwner = repository.owner.trim().toLocaleLowerCase();
    const viewerGithubHandle = typeof user?.github_handle === 'string'
      ? user.github_handle.trim().toLocaleLowerCase()
      : '';
    const isViewerOwner = repository.ownerUserId === user?.user_id
      || (!repository.ownerUserId && Boolean(viewerGithubHandle) && normalizedOwner === viewerGithubHandle);

    if (isViewerOwner) {
      router.push('/(tabs)/profile');
      return;
    }

    router.push({
      pathname: '/user/[username]',
      params: {
        username: repository.owner,
        ...(repository.ownerUserId ? { userId: repository.ownerUserId } : {}),
        ...(repository.ownerBio ? { bio: repository.ownerBio } : {}),
        isFollowing: String(repository.viewerFollowsOwner === true),
        followStateKnown: String(typeof repository.viewerFollowsOwner === 'boolean'),
      },
    } as unknown as Href);
  }, [user]);

  useEffect(() => {
    if (!activityOutbox) return;
    const unsubscribe = activityOutbox.subscribe(async ({ invalidatedFeed }) => {
      if (!invalidatedFeed) return;
      await queryClient.cancelQueries({ queryKey: feedQueryKey, exact: true });
      await queryClient.resetQueries({ queryKey: feedQueryKey, exact: true });
      await checkOnboardingStatus();
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
  }, [activityOutbox, checkOnboardingStatus, feedQueryKey, flushActivityBatch, queryClient]);

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
              onOwnerPress={() => openOwnerProfile(item.repository)}
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
              void flushActivityBatch()
                .then(({ invalidatedFeed }) => {
                  if (!invalidatedFeed) return fetchNextPage();
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
