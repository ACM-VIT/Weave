import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { ArrowLeft, UserRound } from 'lucide-react-native';
import { apiV2, apiV2Raw } from '@/api/client';
import { useAuth } from '@/store/AuthContext';
import {
  buildFollowMutation,
  collectConnectionIds,
  CONNECTION_PAGE_SIZE,
  FOLLOWING_LOOKUP_PAGE_SIZE,
  getNextConnectionOffset,
  mergeConnectionPages,
  type ConnectionPage,
} from '@/utils/connection-pagination';
import { getStorageItem } from '@/utils/storage';

type Person = {
  user_id: string;
  username: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function ConnectionListScreen({ type }: { type: 'followers' | 'following' }) {
  const { width } = useWindowDimensions();
  const { username, userId } = useLocalSearchParams<{ username?: string; userId?: string }>();
  const { user, checkOnboardingStatus } = useAuth();
  const queryClient = useQueryClient();
  const currentUserId = user?.user_id;
  const [followOverrides, setFollowOverrides] = useState<Record<string, boolean>>({});
  const [pendingFollowIds, setPendingFollowIds] = useState<Set<string>>(() => new Set());
  const pendingFollowIdsRef = useRef<Set<string>>(new Set());
  const [followErrors, setFollowErrors] = useState<Record<string, string>>({});
  const title = type === 'followers' ? 'Followers' : 'Following';
  const connectionQueryKey = ['connections', userId, type] as const;
  const followingIdsQueryKey = ['connection-following-ids', currentUserId] as const;
  const isOwnFollowingList = Boolean(currentUserId && userId === currentUserId && type === 'following');

  useEffect(() => {
    setFollowOverrides({});
    setPendingFollowIds(new Set());
    pendingFollowIdsRef.current.clear();
    setFollowErrors({});
  }, [currentUserId, type, userId]);

  const connectionsQuery = useInfiniteQuery({
    queryKey: connectionQueryKey,
    enabled: Boolean(userId),
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const token = await getStorageItem('access_token');
      if (!token) throw new Error('Your session has expired. Please log in again.');
      return apiV2<ConnectionPage<Person>>(
        `/users/${encodeURIComponent(userId!)}/${type}?limit=${CONNECTION_PAGE_SIZE}&offset=${pageParam}`,
        { signal },
        token,
      );
    },
    getNextPageParam: (lastPage) => getNextConnectionOffset(lastPage),
  });

  const followingIdsQuery = useQuery({
    queryKey: followingIdsQueryKey,
    enabled: Boolean(currentUserId && !isOwnFollowingList),
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const token = await getStorageItem('access_token');
      if (!token) throw new Error('Your session has expired. Please log in again.');
      return collectConnectionIds((offset, limit) => apiV2<ConnectionPage<Person>>(
        `/users/${encodeURIComponent(currentUserId!)}/following?limit=${limit}&offset=${offset}`,
        { signal },
        token,
      ), FOLLOWING_LOOKUP_PAGE_SIZE);
    },
  });

  const people = useMemo(
    () => mergeConnectionPages(connectionsQuery.data?.pages ?? []),
    [connectionsQuery.data?.pages],
  );
  const followingIds = useMemo(
    () => new Set(followingIdsQuery.data ?? []),
    [followingIdsQuery.data],
  );
  const followStateReady = isOwnFollowingList || followingIdsQuery.isSuccess;

  const isFollowing = (personId: string): boolean => {
    if (Object.hasOwn(followOverrides, personId)) return followOverrides[personId];
    return isOwnFollowingList || followingIds.has(personId);
  };

  const toggleFollow = async (person: Person) => {
    if (!currentUserId || person.user_id === currentUserId || !followStateReady
      || pendingFollowIdsRef.current.has(person.user_id)) return;

    const wasFollowing = isFollowing(person.user_id);
    const followMutation = buildFollowMutation(person.user_id, wasFollowing);
    const nextFollowing = followMutation.nextFollowing;
    pendingFollowIdsRef.current.add(person.user_id);
    setPendingFollowIds((current) => new Set(current).add(person.user_id));
    setFollowOverrides((current) => ({ ...current, [person.user_id]: nextFollowing }));
    setFollowErrors((current) => {
      const next = { ...current };
      delete next[person.user_id];
      return next;
    });

    try {
      await queryClient.cancelQueries({ queryKey: followingIdsQueryKey, exact: true });
      const token = await getStorageItem('access_token');
      if (!token) throw new Error('Your session has expired. Please log in again.');
      await apiV2Raw<null>(followMutation.path, {
        method: followMutation.method,
      }, token);

      queryClient.setQueryData<string[]>(followingIdsQueryKey, (current) => {
        const next = new Set(current ?? followingIdsQuery.data ?? []);
        if (nextFollowing) next.add(person.user_id);
        else next.delete(person.user_id);
        return [...next];
      });

      if (isOwnFollowingList && !nextFollowing) {
        queryClient.setQueryData<InfiniteData<ConnectionPage<Person>, number>>(
          connectionQueryKey,
          (current) => current ? {
            ...current,
            pages: current.pages.map((page) => ({
              ...page,
              items: page.items.filter((item) => item.user_id !== person.user_id),
            })),
          } : current,
        );
      }

      void queryClient.invalidateQueries({
        queryKey: ['connections', currentUserId, 'following'],
        exact: true,
      });
      void checkOnboardingStatus().catch(() => undefined);
    } catch (error) {
      setFollowOverrides((current) => ({ ...current, [person.user_id]: wasFollowing }));
      setFollowErrors((current) => ({
        ...current,
        [person.user_id]: errorMessage(error, 'Unable to update this follow.'),
      }));
    } finally {
      pendingFollowIdsRef.current.delete(person.user_id);
      setPendingFollowIds((current) => {
        const next = new Set(current);
        next.delete(person.user_id);
        return next;
      });
    }
  };

  const refresh = () => {
    void connectionsQuery.refetch();
    if (!isOwnFollowingList && currentUserId) void followingIdsQuery.refetch();
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000000', alignItems: 'center' }}>
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        style={{ width: width >= 768 ? '68%' : '100%', maxWidth: 650 }}
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: '7%', paddingBottom: '10%' }}
        data={people}
        keyExtractor={(item) => item.user_id}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        refreshing={connectionsQuery.isRefetching && !connectionsQuery.isFetchingNextPage}
        onRefresh={refresh}
        onEndReached={() => {
          if (connectionsQuery.hasNextPage && !connectionsQuery.isFetchingNextPage) {
            void connectionsQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.6}
        ListHeaderComponent={<View style={{ paddingTop: '8%', paddingBottom: '7%', gap: 18 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable accessibilityLabel="Go back" onPress={() => router.back()} hitSlop={12} style={{ width: '15%' }}><ArrowLeft color="#F7F7F8" size={27} /></Pressable>
            <Text selectable style={{ flex: 1, color: '#F7F7F8', textAlign: 'center', fontFamily: 'NataSans-Bold', fontSize: width < 360 ? 22 : 26 }}>{title}</Text>
            <View style={{ width: '15%' }} />
          </View>
          {username ? <Text selectable style={{ color: '#6F6E74', textAlign: 'center', fontFamily: 'NataSans-Regular' }}>@{username}</Text> : null}
          {followingIdsQuery.isError && !isOwnFollowingList ? <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading follow status"
            onPress={() => { void followingIdsQuery.refetch(); }}
            style={{ alignSelf: 'center', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: '#242424' }}
          >
            <Text style={{ color: '#FF6878', fontFamily: 'NataSans-SemiBold', textAlign: 'center' }}>Couldn&apos;t load follow status. Retry</Text>
          </Pressable> : null}
        </View>}
        ListEmptyComponent={<View style={{ minHeight: 320, flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }}>
          {connectionsQuery.isLoading ? <ActivityIndicator color="#63E08A" /> : <>
            <View style={{ width: '18%', maxWidth: 74, aspectRatio: 1, borderRadius: 999, backgroundColor: '#151515', alignItems: 'center', justifyContent: 'center' }}><UserRound size={31} color="#63E08A" /></View>
            <Text selectable style={{ color: '#F7F7F8', fontFamily: 'NataSans-SemiBold', fontSize: 17, textAlign: 'center' }}>
              {!userId ? 'Profile is unavailable.' : connectionsQuery.isError
                ? errorMessage(connectionsQuery.error, `Unable to load ${type}.`)
                : `No ${type} yet`}
            </Text>
            {connectionsQuery.isError && userId ? <Pressable
              accessibilityRole="button"
              onPress={() => { void connectionsQuery.refetch(); }}
              style={{ paddingHorizontal: 20, paddingVertical: 11, borderRadius: 12, backgroundColor: '#292929' }}
            ><Text style={{ color: '#F7F7F8', fontFamily: 'NataSans-SemiBold' }}>Try again</Text></Pressable> : null}
          </>}
        </View>}
        ListFooterComponent={<View style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingTop: 12 }}>
          {connectionsQuery.isFetchingNextPage ? <ActivityIndicator color="#63E08A" /> : null}
          {connectionsQuery.isFetchNextPageError && people.length > 0 ? <Pressable
            accessibilityRole="button"
            onPress={() => { void connectionsQuery.fetchNextPage(); }}
            style={{ paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12, backgroundColor: '#292929' }}
          ><Text style={{ color: '#FF6878', fontFamily: 'NataSans-SemiBold' }}>Couldn&apos;t load more. Retry</Text></Pressable> : null}
        </View>}
        renderItem={({ item }) => {
          const self = item.user_id === currentUserId;
          const following = isFollowing(item.user_id);
          const pending = pendingFollowIds.has(item.user_id);
          const relationshipLoading = !followStateReady && !followingIdsQuery.isError;
          return <View style={{ gap: 6 }}>
            <View style={{ minHeight: width < 360 ? 70 : 78, borderRadius: 20, borderCurve: 'continuous', backgroundColor: '#151515', paddingHorizontal: '4%', flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              {item.avatar_url ? <Image source={{ uri: item.avatar_url }} resizeMode="cover" accessibilityLabel={`${item.full_name || item.username}'s avatar`} style={{ width: '14%', maxWidth: 52, aspectRatio: 1, borderRadius: 999 }} /> : <View style={{ width: '14%', maxWidth: 52, aspectRatio: 1, borderRadius: 999, backgroundColor: '#984BE0', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: 'white', fontFamily: 'NataSans-Bold', fontSize: 16 }}>{(item.full_name || item.username).slice(0, 2).toUpperCase()}</Text></View>}
              <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={{ color: '#F7F7F8', fontFamily: 'NataSans-SemiBold', fontSize: width < 360 ? 14 : 16 }}>{item.full_name || item.username}</Text><Text selectable numberOfLines={1} style={{ color: '#77767C', fontFamily: 'NataSans-Regular', fontSize: 13 }}>@{item.username}</Text></View>
              {!self && currentUserId ? <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${following ? 'Unfollow' : 'Follow'} ${item.username}`}
                accessibilityState={{ busy: pending || relationshipLoading, disabled: pending || !followStateReady, selected: following }}
                disabled={pending || !followStateReady}
                onPress={() => { void toggleFollow(item); }}
                style={({ pressed }) => ({
                  minWidth: width < 360 ? 78 : 92,
                  minHeight: 38,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                  borderWidth: following ? 1 : 0,
                  borderColor: '#4B4A50',
                  backgroundColor: following ? '#292929' : '#63E08A',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed || pending || !followStateReady ? 0.65 : 1,
                })}
              >
                {pending || relationshipLoading ? <ActivityIndicator size="small" color={following ? '#F7F7F8' : '#071009'} /> : <Text style={{ color: following ? '#F7F7F8' : '#071009', fontFamily: 'NataSans-Bold', fontSize: 13 }}>{following ? 'Following' : 'Follow'}</Text>}
              </Pressable> : null}
            </View>
            {followErrors[item.user_id] ? <Text selectable style={{ color: '#FF6878', fontFamily: 'NataSans-Regular', fontSize: 12, paddingHorizontal: 12 }}>{followErrors[item.user_id]}</Text> : null}
          </View>;
        }}
      />
    </View>
  );
}
