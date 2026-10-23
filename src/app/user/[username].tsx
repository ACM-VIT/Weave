import { useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getPublicUserProfile,
  type PublicUserProfile,
} from '@/api/profile';
import {
  getSocialProfile,
  type SocialProfile,
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

  const profileQuery = useQuery({
    queryKey: ['public-user-profile', targetKind, targetId],
    enabled: targetKind !== 'route',
    queryFn: async ({ signal }) => {
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
        data: await getSocialProfile(profileId!, token, signal),
      };
    },
    staleTime: 60_000,
  });

  const profile = useMemo<OtherUserProfileData>(() => {
    const fetchedUser = profileQuery.data?.kind === 'user'
      ? profileQuery.data.data
      : undefined;
    const fetchedProfile = profileQuery.data?.kind === 'profile'
      ? profileQuery.data.data
      : undefined;
    const username = fetchedUser?.username?.trim()
      || fetchedProfile?.username?.trim()
      || fetchedProfile?.handle?.trim()
      || routeUsername;
    const externalRepositories = mapRepositoryList(fetchedProfile?.repositories ?? []);
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
      lists: [],
      pinnedRepositories: externalRepositories,
    };
  }, [
    params.followStateKnown,
    params.followers,
    params.following,
    params.isFollowing,
    params.likes,
    profileQuery.data,
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
    queryClient.setQueryData<{
      kind: 'user';
      data: PublicUserProfile;
    } | {
      kind: 'profile';
      data: SocialProfile;
    }>(
      ['public-user-profile', targetKind, targetId],
      (current) => {
        if (!current) return current;
        if (current.kind === 'user') {
          if (current.data.viewer_follows_user === following) return current;
          return {
            ...current,
            data: {
              ...current.data,
              viewer_follows_user: following,
              followers_count: Math.max(
                0,
                current.data.followers_count + (following ? 1 : -1),
              ),
            },
          };
        }
        if (current.data.viewer_follows_profile === following) return current;
        return {
          ...current,
          data: {
            ...current.data,
            viewer_follows_profile: following,
            followers_count: Math.max(
              0,
              current.data.followers_count + (following ? 1 : -1),
            ),
          },
        };
      },
    );
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
        onListPress={() => undefined}
        onRepositoryPress={openRepository}
        profile={profile}
      />
      <ConnectionSheet
        onClose={() => setConnectionType(null)}
        onFollowingCountChange={() => {
              }}
        type={connectionType ?? 'followers'}
        userId={profile.userId}
        username={profile.username}
        visible={connectionType !== null}
      />
    </>
  );
}
