import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { setUserFollowing } from '@/api/connections';
import { setSocialProfileFollowing } from '@/api/social-profiles';
import { REFERENCE_THEME } from '@/constants/theme';
import { followStateQueryKey, getProfileFollowIdentity } from '@/utils/follow-state';
import { getStorageItem } from '@/utils/storage';

export type FollowButtonProps = {
  targetUserId?: string | null;
  targetProfileId?: string | null;
  isFollowing: boolean;
  stateKnown?: boolean;
  compact?: boolean;
  neutral?: boolean;
  localOnly?: boolean;
  disabled?: boolean;
  onFollowingChange?: (following: boolean) => void;
  onError?: (error: Error) => void;
  style?: StyleProp<ViewStyle>;
  accentColor?: string;
  identityKey?: string | null;
};

export function FollowButton({
  targetUserId,
  targetProfileId,
  isFollowing,
  stateKnown = true,
  compact = false,
  neutral = false,
  localOnly = false,
  disabled = false,
  onFollowingChange,
  onError,
  style,
  accentColor = REFERENCE_THEME.accent,
  identityKey,
}: FollowButtonProps) {
  const queryClient = useQueryClient();
  const targetId = targetProfileId ?? targetUserId;
  const followIdentity = getProfileFollowIdentity(
    targetProfileId,
    targetUserId,
    identityKey,
  );
  const queryKey = followStateQueryKey(followIdentity);
  const followStateQuery = useQuery<boolean>({
    queryKey,
    queryFn: async () => isFollowing,
    initialData: isFollowing,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const [failureState, setFailureState] = useState({
    identity: followIdentity,
    failed: false,
  });
  const displayedFollowing = followStateQuery.data;
  const failed = failureState.identity === followIdentity && failureState.failed;

  const mutation = useMutation<void, Error, boolean>({
    mutationFn: async (following) => {
      if (localOnly) return;
      if (!targetId) throw new Error('This profile is unavailable.');
      const token = await getStorageItem('access_token');
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      if (targetProfileId) {
        await setSocialProfileFollowing(targetProfileId, following, token);
      } else {
        await setUserFollowing(targetId, following, token);
      }
    },
  });
  useEffect(() => {
    if (!mutation.isPending) {
      queryClient.setQueryData(queryKey, isFollowing);
    }
  }, [isFollowing, mutation.isPending, queryClient, queryKey]);

  const targetAvailable = localOnly || (Boolean(targetId) && stateKnown);
  const buttonDisabled = disabled || !targetAvailable || mutation.isPending;
  const accessibilityHint = localOnly
    ? 'Preview follow state is kept for this session.'
    : !targetId
    ? 'This profile is unavailable.'
    : !stateKnown
      ? 'Follow status is unavailable for this repository owner.'
      : failed
        ? 'The last follow request failed. Try again.'
        : undefined;

  const toggleFollowing = () => {
    if (buttonDisabled) return;
    const previous = displayedFollowing;
    const next = !previous;
    queryClient.setQueryData(queryKey, next);
    setFailureState({ identity: followIdentity, failed: false });

    mutation.mutate(next, {
      onError: (error) => {
        queryClient.setQueryData(queryKey, previous);
        setFailureState({ identity: followIdentity, failed: true });
        onError?.(error);
      },
      onSuccess: () => {
        onFollowingChange?.(next);
      },
    });
  };

  return (
    <Pressable
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
        busy: mutation.isPending,
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
        style,
      ]}
    >
      {mutation.isPending ? (
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
