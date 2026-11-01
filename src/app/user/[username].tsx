import { useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';

import {
  getPublicUserProfile,
  getPublicUserBoardsPage,
  type PublicUserProfile,
} from '@/api/profile';
import {
  getSocialProfilePage,
  type SocialProfilePage,
} from '@/api/social-profiles';
import { ConnectionSheet, type ConnectionType } from '@/components/connection-sheet';
import {
  OtherUserProfile,
  type OtherUserProfileData,
} from '@/components/other-user-profile';
import type { RepositoryDetail } from '@/models/repository';
import { useAuth } from '@/store/AuthContext';
import {
  followStateQueryKey,
  getProfileFollowIdentity,
} from '@/utils/follow-state';
import { getStorageItem } from '@/utils/storage';
import { repositoryHref } from '@/utils/repository-links';
import { mapRepositoryList } from '@/utils/repository-mapper';

type ProfilePage = { kind: 'user'; data: PublicUserProfile } | { kind: 'profile'; data: SocialProfilePage };

type OtherUserRouteParams = {
  username?: string | string[];
  userId?: string | string[];
  profileId?: string | string[];
  displayName?: string | string[];
  bio?: string | string[];
  avatarUrl?: string | string[];
  isFollowing?: string | string[];
  followStateKnown?: string | string[];
  likes?: string | string[];
  followers?: string | string[];
  following?: string | string[];
};

function firstParam(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function countParam(value: string | string[] | undefined) {
  const parsed = Number(firstParam(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function booleanParam(value: string | string[] | undefined) {
  return firstParam(value) === 'true';
}

export default function OtherUserProfileRoute() {
  const params = useLocalSearchParams<OtherUserRouteParams>();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const routeUsername = firstParam(params.username).replace(/^@/, '') || 'developer';
  const userId = firstParam(params.userId) || undefined;
  const profileId = firstParam(params.profileId) || undefined;
  const routeDisplayName = firstParam(params.displayName);
  const routeBio = firstParam(params.bio) || null;
  const routeAvatarUrl = firstParam(params.avatarUrl) || null;
  const [connectionType, setConnectionType] = useState<ConnectionType | null>(null);
  const targetKind = userId ? 'user' : profileId ? 'profile' : 'route';
  const targetId = userId ?? profileId ?? routeUsername;

  const viewer = user?.user_id;
  const profileKey = ['public-user-profile', viewer, targetKind, targetId] as const;
  const [listsFor, setListsFor] = useState<string | null>(null);
  const profileQuery = useInfiniteQuery({
    queryKey: profileKey,
    enabled: Boolean(viewer) && targetKind !== 'route',
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }): Promise<ProfilePage> => {
      const token = await getStorageItem('access_token');
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      if (userId) {
        return {
          kind: 'user' as const,
          data: await getPublicUserProfile(userId, token, signal),
        };
      }
      return {
        kind: 'profile' as const,
        data: await getSocialProfilePage(profileId!, token, { limit: 25, cursor: pageParam }, signal),
      };
    },
    getNextPageParam: (last) => last.kind === 'profile' && last.data.has_more ? last.data.next_cursor ?? undefined : undefined,
    staleTime: 60_000,
  });
  const firstPage = profileQuery.data?.pages[0];
  const listOwner = userId || (firstPage?.kind === 'profile' ? firstPage.data.claimed_by_user_id : undefined);
  const listsRequested = listsFor === targetId;
  const listsQuery = useInfiniteQuery({
    queryKey: ['public-profile-lists', viewer, listOwner],
    enabled: Boolean(viewer && listOwner && listsRequested),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) => {
      const token = await getStorageItem('access_token');
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      return getPublicUserBoardsPage(listOwner!, token, { limit: 25, cursor: pageParam }, signal);
    },
    getNextPageParam: (last) => last.has_more ? last.next_cursor ?? undefined : undefined,
    staleTime: 60_000,
  });

  const profile = useMemo<OtherUserProfileData>(() => {
    const fetchedUser = firstPage?.kind === 'user'
      ? firstPage.data
      : undefined;
    const fetchedProfile = firstPage?.kind === 'profile'
      ? firstPage.data
      : undefined;
    const username = fetchedUser?.username?.trim()
      || fetchedProfile?.username?.trim()
      || fetchedProfile?.handle?.trim()
      || routeUsername;
    // updated_at can move a repository across keyset page boundaries. Keep one
    // canonical card without changing the server cursor or treating a short page as exhaustion.
    const externalRepositories = [...new Map(mapRepositoryList(
      profileQuery.data?.pages.flatMap(page => page.kind === 'profile' ? page.data.repositories : []) ?? [],
    ).map(repository => [repository.id, repository])).values()];
    return {
      userId: fetchedUser?.user_id || fetchedProfile?.claimed_by_user_id || userId,
      profileId: fetchedProfile?.profile_id || profileId,
      username,
      displayName: fetchedUser?.full_name?.trim()
        || fetchedProfile?.display_name?.trim()
        || routeDisplayName
        || username,
      bio: fetchedUser?.bio ?? fetchedProfile?.bio ?? routeBio,
      avatarUrl: fetchedUser?.avatar_url ?? fetchedProfile?.avatar_url ?? routeAvatarUrl,
      isSelf: fetchedUser?.is_self
        ?? fetchedProfile?.is_self
        ?? (Boolean(userId) && userId === user?.user_id),
      isFollowing: fetchedUser?.viewer_follows_user
        ?? fetchedProfile?.viewer_follows_profile
        ?? booleanParam(params.isFollowing),
      followStateKnown: fetchedUser !== undefined
        || fetchedProfile !== undefined
        || booleanParam(params.followStateKnown),
      stats: {
        likes: fetchedUser?.likes_given_count
          ?? fetchedProfile?.likes_given_count
          ?? countParam(params.likes),
        followers: fetchedUser?.followers_count
          ?? fetchedProfile?.followers_count
          ?? countParam(params.followers),
        following: fetchedUser?.following_count
          ?? fetchedProfile?.following_count
          ?? countParam(params.following),
      },
      lists: listsQuery.data?.pages.flatMap(page => page.items) ?? [],
      pinnedRepositories: externalRepositories,
    };
  }, [
    params.followStateKnown,
    params.followers,
    params.following,
    params.isFollowing,
    params.likes,
    profileQuery.data,
    firstPage,
    listsQuery.data,
    profileId,
    routeAvatarUrl,
    routeBio,
    routeDisplayName,
    routeUsername,
    userId,
    user?.user_id,
  ]);

  const handleFollowingChange = (following: boolean) => {
    if (profileId) {
      queryClient.setQueryData(
        followStateQueryKey(getProfileFollowIdentity(profileId), user?.user_id),
        following,
      );
    }
    if (profile.userId) {
      queryClient.setQueryData(
        followStateQueryKey(getProfileFollowIdentity(null, profile.userId), user?.user_id),
        following,
      );
    }
    queryClient.setQueryData<InfiniteData<ProfilePage>>(profileKey, current => {
      if (!current) return current;
      return { ...current, pages: current.pages.map(page => {
        const field = page.kind === 'user' ? 'viewer_follows_user' : 'viewer_follows_profile';
        if ((page.data as unknown as Record<string, unknown>)[field] === following) return page;
        return { ...page, data: { ...page.data, [field]: following,
          followers_count: Math.max(0, page.data.followers_count + (following ? 1 : -1)),
        }} as ProfilePage;
      }) };
    });
  };

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home');
  };

  const openRepository = (repository: RepositoryDetail) => {
    router.push(repositoryHref(repository.id));
  };

  return (
    <>
      <OtherUserProfile
        key={profile.profileId || profile.userId || profile.username}
        loading={profileQuery.isLoading}
        followStateUpdatedAt={profileQuery.dataUpdatedAt || undefined}
        onBack={goBack}
        onFollowersPress={profile.userId ? () => setConnectionType('followers') : undefined}
        onFollowingPress={profile.userId ? () => setConnectionType('following') : undefined}
        onFollowError={(error) => Alert.alert('Follow failed', error.message)}
        onFollowingChange={handleFollowingChange}
        onListsOpen={() => setListsFor(targetId)}
        listsPage={{
          loading: listsRequested && (profileQuery.isLoading || (Boolean(listOwner) && listsQuery.isFetching)),
          error: listsRequested && (profileQuery.isError || (Boolean(listOwner) && listsQuery.isError)),
          hasMore: listsQuery.hasNextPage,
          onLoadMore: () => { if (!listsQuery.isFetching) void listsQuery.fetchNextPage(); },
          onRetry: () => { if (profileQuery.isError) void profileQuery.refetch();
            else void (listsQuery.isFetchNextPageError ? listsQuery.fetchNextPage() : listsQuery.refetch()); },
        }}
        repositoriesPage={{
          loading: profileQuery.isFetching,
          error: profileQuery.isError,
          hasMore: profileQuery.hasNextPage,
          onLoadMore: () => { if (!profileQuery.isFetching) void profileQuery.fetchNextPage(); },
          onRetry: () => { void (profileQuery.isFetchNextPageError ? profileQuery.fetchNextPage() : profileQuery.refetch()); },
        }}
        onListPress={(id) => {
          const list = profile.lists.find(item => item.id === id);
          if (list) router.push({ pathname: '/board', params: {
            boardId: list.id, boardName: list.name, boardDescription: list.description ?? '',
          }});
        }}
        onRepositoryPress={openRepository}
        profile={profile}
      />
      <ConnectionSheet
        onClose={() => setConnectionType(null)}
        onFollowingCountChange={() => {}}
        onRepositoryPress={(href) => router.push(href)}
        type={connectionType ?? 'followers'}
        userId={profile.userId}
        username={profile.username}
        visible={connectionType !== null}
      />
    </>
  );
}
