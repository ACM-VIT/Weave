import { rememberRepositoryPreview } from '@/services/repositoryPreview';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CircleAlert, FolderOpen, Pin } from 'lucide-react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  getBoardRepositoriesPage,
  getCollectionRepositoriesPage,
} from '@/api/boards';
import RepoCard from '@/components/explore/RepoCard';
import { loadPinnedRepositories } from '@/services/pinnedRepositoryStorage';
import { listRepositoryQueryOptions } from '@/services/accountQueryCache';
import { useAuth } from '@/store/AuthContext';
import { repositoryHref } from '@/utils/repository-links';
import { retryKeysetQuery } from '@/services/keysetQueryRecovery';
import { authSessionLifecycle } from '@/api/session-lifecycle';
import { mapPinnedRepository } from '@/utils/repository-mapper';
import { getStorageItem } from '@/utils/storage';

type BoardRouteParams = {
  boardId?: string | string[];
  boardName?: string | string[];
  boardDescription?: string | string[];
  collectionId?: string | string[];
  collectionType?: string | string[];
};

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export default function BoardScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<BoardRouteParams>();
  const boardId = firstParam(params.boardId);
  const collectionId = firstParam(params.collectionId);
  const collectionType = firstParam(params.collectionType);
  const isPinnedCollection = collectionType === 'pinned';
  const isRepositoryCollection = collectionType === 'collection';
  const boardName = firstParam(params.boardName) || 'List';
  const boardDescription = firstParam(params.boardDescription);
  const isCompact = width < 360;

  const repositoriesQuery = useInfiniteQuery(listRepositoryQueryOptions(
    isPinnedCollection ? 'pinned' : isRepositoryCollection ? 'collection' : 'board',
    user?.user_id, isPinnedCollection ? '' : isRepositoryCollection ? collectionId : boardId,
    async (cursor, signal) => {
      const generation = authSessionLifecycle.currentGeneration();
      if (isPinnedCollection) {
        const items = (await loadPinnedRepositories(user!.user_id)).map(mapPinnedRepository)
          .filter((repository) => repository !== null);
        authSessionLifecycle.assertCurrent(generation); signal.throwIfAborted();
        return {items, has_more:false, next_cursor:null};
      }
      const token = await getStorageItem('access_token');
      authSessionLifecycle.assertCurrent(generation); signal.throwIfAborted();
      if (!token) throw new Error('Your session has expired. Please log in again.');
      const page = await (isRepositoryCollection
        ? getCollectionRepositoriesPage(collectionId, token, {limit:25,cursor:cursor ?? undefined}, signal)
        : getBoardRepositoriesPage(boardId, token, {limit:25,cursor:cursor ?? undefined}, signal));
      authSessionLifecycle.assertCurrent(generation);
      return page;
    },
  ));
  const repositories = [...new Map((repositoriesQuery.data?.pages.flatMap(page => page.items) ?? [])
    .map(repository => [repository.id,repository])).values()];

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/profile');
  };

  const openRepository = (repositoryId: string) => {
    const repository = repositories.find(item => item.id === repositoryId);
    if (repository) rememberRepositoryPreview(queryClient, user?.user_id, repository);
    router.push(repositoryHref(repositoryId));
  };

  const repositoryCountLabel = repositoriesQuery.isSuccess
    ? `${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}${repositoriesQuery.hasNextPage ? ' loaded' : ''}`
    : null;

  return (
    <View style={styles.screen}>
      <View style={[styles.content, { maxWidth: width >= 768 ? 720 : undefined }]}>
        <View
          style={[
            styles.header,
            {
              paddingTop: Math.max(insets.top, 16) + (width >= 768 ? 16 : 8),
              paddingHorizontal: width >= 768 ? 28 : 20,
            },
          ]}
        >
          <Pressable
            accessibilityLabel="Go back to profile"
            accessibilityRole="button"
            hitSlop={12}
            onPress={goBack}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
          >
            <ArrowLeft color="#F7F7F8" size={isCompact ? 23 : 27} strokeWidth={1.9} />
          </Pressable>

          <View style={styles.headerCopy}>
            <Text numberOfLines={1} selectable style={[styles.title, isCompact && styles.titleCompact]}>
              {boardName}
            </Text>
            {boardDescription ? (
              <Text numberOfLines={2} selectable style={styles.subtitle}>
                {boardDescription}
              </Text>
            ) : repositoryCountLabel ? (
              <Text style={styles.subtitle}>{repositoryCountLabel}</Text>
            ) : null}
            {boardDescription && repositoryCountLabel ? (
              <Text style={styles.count}>{repositoryCountLabel}</Text>
            ) : null}
          </View>

          <View style={styles.headerSpacer} />
        </View>

        <FlatList
          contentContainerStyle={[
            styles.listContent,
            {
              paddingHorizontal: width >= 768 ? 28 : 20,
              paddingBottom: Math.max(insets.bottom, 24) + 20,
            },
          ]}
          contentInsetAdjustmentBehavior="never"
          data={repositories}
          initialNumToRender={8}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          keyExtractor={(repository) => repository.id}
          ListEmptyComponent={
            <View style={styles.state}>
              {!boardId && !isPinnedCollection && !collectionId ? (
                <>
                  <View style={styles.stateIcon}>
                    <CircleAlert color="#FF6878" size={31} strokeWidth={1.7} />
                  </View>
                  <Text selectable style={styles.stateTitle}>This list could not be opened.</Text>
                  <Text selectable style={styles.stateMessage}>Return to your profile and choose the list again.</Text>
                  <Pressable onPress={goBack} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
                    <Text style={styles.secondaryButtonLabel}>Back to profile</Text>
                  </Pressable>
                </>
              ) : repositoriesQuery.isLoading ? (
                <>
                  <ActivityIndicator color="#63E08A" size="large" />
                  <Text style={styles.stateMessage}>Loading repositories…</Text>
                </>
              ) : repositoriesQuery.isError ? (
                <>
                  <View style={styles.stateIcon}>
                    <CircleAlert color="#FF6878" size={31} strokeWidth={1.7} />
                  </View>
                  <Text selectable style={styles.stateTitle}>Unable to load this list.</Text>
                  <Text selectable style={styles.stateMessage}>
                    {repositoriesQuery.error instanceof Error
                      ? repositoriesQuery.error.message
                      : 'Please check your connection and try again.'}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void repositoriesQuery.refetch()}
                    style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.retryButtonLabel}>Try again</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <View style={styles.stateIcon}>
                    {isPinnedCollection ? (
                      <Pin color="#63E08A" size={31} strokeWidth={1.8} />
                    ) : (
                      <FolderOpen color="#63E08A" size={33} strokeWidth={1.7} />
                    )}
                  </View>
                  <Text selectable style={styles.stateTitle}>
                    {isPinnedCollection ? 'No pinned repositories yet.' : 'No repositories in this list yet.'}
                  </Text>
                  <Text selectable style={styles.stateMessage}>
                    {isPinnedCollection
                      ? 'Pin a repository from Home and it will appear here.'
                      : 'Save a repository to this list and it will appear here.'}
                  </Text>
                </>
              )}
            </View>
          }
          ListFooterComponent={repositoriesQuery.hasNextPage || (repositories.length > 0 && repositoriesQuery.isError) ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Load more List repositories"
              disabled={repositoriesQuery.isFetching}
              onPress={() => void (repositoriesQuery.isError ? retryKeysetQuery(repositoriesQuery)
                : repositoriesQuery.fetchNextPage({cancelRefetch:false}))}
              style={styles.retryButton}>
              {repositoriesQuery.isFetching ? <ActivityIndicator color={styles.retryButtonLabel.color} />
                : <Text style={styles.retryButtonLabel}>{repositoriesQuery.isError ? 'Try again' : 'Load more'}</Text>}
            </Pressable>
          ) : null}
          onEndReached={() => {
            if (repositoriesQuery.hasNextPage && !repositoriesQuery.isFetching && !repositoriesQuery.isError)
              void repositoriesQuery.fetchNextPage({cancelRefetch:false});
          }}
          onEndReachedThreshold={0.5}
          renderItem={({ item }) => (
            <View>
              <RepoCard
                onPress={() => openRepository(item.id)}
                repo={item}
                showMetrics={false}
              />
            </View>
          )}
          showsVerticalScrollIndicator={false}
          style={styles.list}
          windowSize={7}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#000000',
  },
  content: {
    width: '100%',
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingBottom: 18,
    gap: 12,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    width: 38,
    height: 38,
    alignItems: 'flex-start',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    gap: 4,
  },
  headerSpacer: {
    width: 38,
    flexShrink: 0,
  },
  title: {
    color: '#F7F7F8',
    fontFamily: 'NataSans-Bold',
    fontSize: 25,
    lineHeight: 31,
    textAlign: 'center',
  },
  titleCompact: {
    fontSize: 21,
    lineHeight: 27,
  },
  subtitle: {
    color: '#77767C',
    fontFamily: 'NataSans-Regular',
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  count: {
    color: '#63E08A',
    fontFamily: 'NataSans-Medium',
    fontSize: 11,
    lineHeight: 15,
    textAlign: 'center',
  },
  list: {
    flex: 1,
  },
  listContent: {
    flexGrow: 1,
    paddingTop: 20,
  },
  separator: {
    height: 12,
  },
  state: {
    flex: 1,
    minHeight: 360,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 12,
  },
  stateIcon: {
    width: 70,
    height: 70,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 35,
    backgroundColor: '#151515',
    marginBottom: 3,
  },
  stateTitle: {
    color: '#F7F7F8',
    fontFamily: 'NataSans-SemiBold',
    fontSize: 17,
    lineHeight: 23,
    textAlign: 'center',
  },
  stateMessage: {
    maxWidth: 360,
    color: '#77767C',
    fontFamily: 'NataSans-Regular',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  retryButton: {
    minWidth: 124,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    borderCurve: 'continuous',
    backgroundColor: '#63E08A',
    paddingHorizontal: 20,
    marginTop: 5,
  },
  retryButtonLabel: {
    color: '#071009',
    fontFamily: 'NataSans-Bold',
    fontSize: 14,
  },
  secondaryButton: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    borderCurve: 'continuous',
    backgroundColor: '#242424',
    paddingHorizontal: 20,
    marginTop: 5,
  },
  secondaryButtonLabel: {
    color: '#F7F7F8',
    fontFamily: 'NataSans-SemiBold',
    fontSize: 14,
  },
  pressed: {
    opacity: 0.7,
  },
  opening: {
    opacity: 0.62,
  },
});
