import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { setUserFollowing } from '@/api/connections';
import { setSocialProfileFollowing } from '@/api/social-profiles';
import { REFERENCE_THEME } from '@/constants/theme';
import { followStateQueryKey, getProfileFollowIdentity } from '@/utils/follow-state';
import { useAuth } from '@/store/AuthContext';
import { authSessionLifecycle } from '@/api/session-lifecycle';
import { settleFollowCache } from '@/services/followMutationCache';
import { getStorageItem } from '@/utils/storage';

export type FollowButtonProps = {
  targetUserId?: string | null;
  targetProfileId?: string | null;
  isFollowing: boolean;
  stateKnown?: boolean;
  compact?: boolean;
  neutral?: boolean;
  disabled?: boolean;
  onFollowingChange?: (following: boolean) => void;
  /** Successful request observation; runs even if the initiating control unmounts. */
  onFollowingCommitted?: (following: boolean) => void;
  onError?: (error: Error) => void;
  style?: StyleProp<ViewStyle>;
  followingStyle?: StyleProp<ViewStyle>;
  followingLabelStyle?: StyleProp<TextStyle>;
  accentColor?: string;
  identityKey?: string | null;
  stateUpdatedAt?: number;
};

export function FollowButton({
  targetUserId,
  targetProfileId,
  isFollowing,
  stateKnown = true,
  compact = false,
  neutral = false,
  disabled = false,
  onFollowingChange,
  onFollowingCommitted,
  onError,
  style,
  followingStyle,
  followingLabelStyle,
  accentColor = REFERENCE_THEME.accent,
  identityKey,
  stateUpdatedAt,
}: FollowButtonProps) {
  const queryClient = useQueryClient();
  const { user, checkOnboardingStatus } = useAuth();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const viewer = user?.user_id;
  const renderGeneration = authSessionLifecycle.currentGeneration();
  const targetId = targetProfileId ?? targetUserId;
  const followIdentity = getProfileFollowIdentity(
    targetProfileId,
    targetUserId,
    identityKey,
  );
  const queryKey = followStateQueryKey(followIdentity, viewer);
  const followStateQuery = useQuery<boolean>({
    queryKey,
    queryFn: async () => isFollowing,
    initialData: isFollowing,
    initialDataUpdatedAt: stateUpdatedAt,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const [failureState, setFailureState] = useState({
    identity: followIdentity,
    failed: false,
  });
  const displayedFollowing = followStateQuery.data;
  const controlIdentity = JSON.stringify(queryKey);
  const failed = failureState.identity === controlIdentity && failureState.failed;

  const mutationKey = ['follow', viewer, followIdentity] as const;
  const pending = useIsMutating({ mutationKey, exact: true });
  type Change = { following: boolean; previous: boolean; generation: number; viewer: string;
    identity: string; userId?: string | null; profileId?: string | null;
    changed?: (following: boolean) => void; committed?: (following: boolean) => void; failed?: (error: Error) => void };
  const mutation = useMutation<void, Error, Change>({
    mutationKey,
    mutationFn: async ({ following, generation, userId, profileId }) => {
      authSessionLifecycle.assertCurrent(generation);
      if (!profileId && !userId) throw new Error('This profile is unavailable.');
      const token = await getStorageItem('access_token');
      authSessionLifecycle.assertCurrent(generation);
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      if (profileId) await setSocialProfileFollowing(profileId, following, token);
      else await setUserFollowing(userId!, following, token);
    },
    onError: (error, change) => {
      if (!authSessionLifecycle.isCurrent(change.generation)) return;
      const key = followStateQueryKey(change.identity, change.viewer);
      if (queryClient.getQueryData(key) === change.following) queryClient.setQueryData(key, change.previous);
      if (mounted.current) {
        setFailureState({ identity: JSON.stringify(key), failed: true });
        change.failed?.(error);
      }
    },
    onSuccess: async (_result, change) => {
      if (!authSessionLifecycle.isCurrent(change.generation)) return;
      try { change.committed?.(change.following); }
      catch { console.warn('[FollowButton] Could not record follow observation.'); }
      await settleFollowCache(queryClient, change.viewer, { userId: change.userId, profileId: change.profileId }, change.following, change.generation);
      if (!authSessionLifecycle.isCurrent(change.generation)) return;
      if (mounted.current) change.changed?.(change.following);
      void checkOnboardingStatus?.().catch(() => undefined);
    },
  });
  const serverState = useRef({ identity: JSON.stringify(queryKey), value: isFollowing });
  useEffect(() => {
    const identity = JSON.stringify(queryKey);
    const previous = serverState.current;
    serverState.current = { identity, value: isFollowing };
    // A second mounted button's stale initial prop must not undo another
    // button's optimistic update or successful response.
    const cachedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
    const freshServer = stateUpdatedAt !== undefined && stateUpdatedAt > cachedAt;
    if (pending === 0 && (freshServer || (stateUpdatedAt === undefined
      && previous.identity === identity && previous.value !== isFollowing))) {
      queryClient.setQueryData(queryKey, isFollowing,
        stateUpdatedAt === undefined ? undefined : { updatedAt: stateUpdatedAt });
    }
  }, [isFollowing, pending, stateUpdatedAt, queryClient, queryKey]);

  const targetAvailable = Boolean(targetId) && stateKnown;
  const buttonDisabled = disabled || !viewer || !targetAvailable || pending > 0;
  const accessibilityHint = !targetId
    ? 'This profile is unavailable.'
    : !stateKnown
      ? 'Follow status is unavailable for this repository owner.'
      : failed
        ? 'The last follow request failed. Try again.'
        : undefined;

  const toggleFollowing = () => {
    if (buttonDisabled || !viewer || queryClient.isMutating({ mutationKey, exact: true }) > 0) return;
    const generation = renderGeneration;
    if (!authSessionLifecycle.isCurrent(generation)) return;
    const previous = displayedFollowing;
    const next = !previous;
    queryClient.setQueryData(queryKey, next);
    setFailureState({ identity: controlIdentity, failed: false });

    mutation.mutate({ following: next, previous, generation, viewer, identity: followIdentity,
      userId: targetUserId, profileId: targetProfileId, changed: onFollowingChange, committed: onFollowingCommitted, failed: onError });
  };

  return (
    <Pressable cssInterop={false}
      accessibilityHint={accessibilityHint}
      accessibilityLabel={
        !targetAvailable
          ? 'Follow unavailable'
          : displayedFollowing
            ? 'Unfollow user'
            : 'Follow user'
      }
      accessibilityRole="button"
      accessibilityState={{
        busy: pending > 0,
        disabled: buttonDisabled,
        selected: displayedFollowing,
      }}
      disabled={buttonDisabled}
      onPress={toggleFollowing}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        displayedFollowing
          ? styles.followingButton
          : neutral
            ? styles.neutralFollowButton
            : [styles.followButton, { backgroundColor: accentColor, borderColor: accentColor }],
        failed && styles.failedButton,
        buttonDisabled && styles.disabledButton,
        pressed && styles.pressedButton,
        displayedFollowing && followingStyle,
        style,
      ]}
    >
      {pending > 0 ? (
        <ActivityIndicator
          color={displayedFollowing || neutral ? REFERENCE_THEME.text : '#071009'}
          size="small"
        />
      ) : (
        <Text
          numberOfLines={1}
          style={[
            styles.label,
            compact && styles.labelCompact,
            displayedFollowing || neutral ? styles.followingLabel : styles.followLabel,
            displayedFollowing && followingLabelStyle,
          ]}
        >
          {displayedFollowing ? 'Following' : 'Follow'}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 88,
    height: 34,
    borderRadius: 999,
    borderCurve: 'continuous',
    borderWidth: 1,
    paddingHorizontal: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonCompact: {
    minWidth: 70,
    height: 28,
    paddingHorizontal: 11,
  },
  followButton: {
    borderColor: REFERENCE_THEME.accent,
    backgroundColor: REFERENCE_THEME.accent,
  },
  neutralFollowButton: {
    borderColor: '#444444',
    backgroundColor: '#2B2B2B',
  },
  followingButton: {
    borderColor: REFERENCE_THEME.border,
    backgroundColor: REFERENCE_THEME.controlStrong,
  },
  failedButton: {
    borderColor: REFERENCE_THEME.danger,
  },
  disabledButton: {
    opacity: 0.45,
  },
  pressedButton: {
    opacity: 0.78,
    transform: [{ scale: 0.96 }],
  },
  label: {
    fontFamily: 'NataSans-SemiBold',
    fontSize: 13,
    lineHeight: 17,
  },
  labelCompact: {
    fontSize: 11,
    lineHeight: 14,
  },
  followLabel: {
    color: '#071009',
  },
  followingLabel: {
    color: REFERENCE_THEME.text,
  },
});
