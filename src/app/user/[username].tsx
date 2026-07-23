import { useMemo, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getPublicUserProfile } from '@/api/profile';
import { ConnectionSheet, type ConnectionType } from '@/components/connection-sheet';
import {
  OtherUserProfile,
  type OtherUserProfileData,
} from '@/components/other-user-profile';
import { AUTH_BYPASS_ENABLED } from '@/constants/auth';
import { PREVIEW_PROFILE_BOARDS } from '@/data/previewProfile';
import { REPOSITORIES } from '@/data/repositories';
import { useAuth } from '@/store/AuthContext';
import type { Repo } from '@/types';
import { getStorageItem } from '@/utils/storage';

type OtherUserRouteParams = {
  username?: string | string[];
  userId?: string | string[];
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

function repositoryUrl(repository: Repo) {
  return repository.url
    || `https://github.com/${encodeURIComponent(repository.author)}/${encodeURIComponent(repository.name)}`;
}

const DEFAULT_LISTS: OtherUserProfileData['lists'] = PREVIEW_PROFILE_BOARDS.map((list) => ({
  id: list.board_id,
  name: list.name,
  description: list.description,
  repositoryCount: list.repo_count,
}));

const DEFAULT_PINNED_REPOSITORIES: Repo[] = REPOSITORIES.slice(0, 3).map((repository) => ({
  id: `other-profile:${repository.id}:${repository.title}`,
  name: repository.title,
  description: repository.description,
  stars: repository.stats.stars,
  forks: repository.stats.forks,
  author: repository.owner,
  avatarColor: '#23963F',
  avatarInitial: repository.owner.slice(0, 2).toUpperCase(),
  language: repository.techStack?.[0],
  url: `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.title)}`,
}));

export default function OtherUserProfileRoute() {
  const params = useLocalSearchParams<OtherUserRouteParams>();
  const { user } = useAuth();
  const routeUsername = firstParam(params.username).replace(/^@/, '') || 'developer';
  const userId = firstParam(params.userId) || undefined;
  const routeDisplayName = firstParam(params.displayName);
  const routeBio = firstParam(params.bio) || null;
  const routeAvatarUrl = firstParam(params.avatarUrl) || null;
  const [connectionType, setConnectionType] = useState<ConnectionType | null>(null);

  const profileQuery = useQuery({
    queryKey: ['public-user-profile', userId],
    enabled: Boolean(userId) && user?.isPreview !== true && !AUTH_BYPASS_ENABLED,
    queryFn: async ({ signal }) => {
      const token = await getStorageItem('access_token');
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      return getPublicUserProfile(userId!, token, signal);
    },
    staleTime: 60_000,
  });

  const profile = useMemo<OtherUserProfileData>(() => {
    const fetched = profileQuery.data;
    const username = fetched?.username?.trim() || routeUsername;
    return {
      userId: fetched?.user_id || userId,
      username,
      displayName: fetched?.full_name?.trim() || routeDisplayName || username,
      bio: fetched?.bio ?? routeBio,
      avatarUrl: fetched?.avatar_url ?? routeAvatarUrl,
      isFollowing: booleanParam(params.isFollowing),
      followStateKnown: booleanParam(params.followStateKnown),
      stats: {
        likes: fetched?.likes_given_count ?? countParam(params.likes),
        followers: fetched?.followers_count ?? countParam(params.followers),
        following: fetched?.following_count ?? countParam(params.following),
      },
      // Public lists and pins are not exposed yet, so existing preview data
      // keeps both tabs visually complete until a real source can replace it.
      lists: DEFAULT_LISTS,
      pinnedRepositories: DEFAULT_PINNED_REPOSITORIES,
    };
  }, [
    params.followStateKnown,
    params.followers,
    params.following,
    params.isFollowing,
    params.likes,
    profileQuery.data,
    routeAvatarUrl,
    routeBio,
    routeDisplayName,
    routeUsername,
    userId,
  ]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home');
  };

  const openRepository = async (repository: Repo) => {
    try {
      await Linking.openURL(repositoryUrl(repository));
    } catch {
      Alert.alert('Unable to open repository', 'Please try again in a moment.');
    }
  };

  const openList = (listId: string) => {
    const list = DEFAULT_LISTS.find((item) => item.id === listId);
    if (!list) return;
    router.push({
      pathname: '/board',
      params: {
        boardId: list.id,
        boardName: list.name,
        boardDescription: list.description ?? '',
        collectionType: 'preview-board',
      },
    });
  };

  return (
    <>
      <OtherUserProfile
        key={profile.userId || profile.username}
        loading={profileQuery.isLoading}
        onBack={goBack}
        onFollowersPress={() => setConnectionType('followers')}
        onFollowingPress={() => setConnectionType('following')}
        onListPress={openList}
        onRepositoryPress={(repository) => void openRepository(repository)}
        profile={profile}
      />
      <ConnectionSheet
        onClose={() => setConnectionType(null)}
        type={connectionType ?? 'followers'}
        userId={profile.userId}
        username={profile.username}
        visible={connectionType !== null}
      />
    </>
  );
}
