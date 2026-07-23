import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Bookmark,
  CircleAlert,
  Eye,
  GitFork,
  MessageCircle,
  Pin,
  Share as ShareIcon,
  Star,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react-native';

import { REFERENCE_THEME } from '@/constants/theme';
import { useAuth } from '@/store/AuthContext';
import { getAvatarColor } from '@/utils/avatar-color';
import type { RepositoryData } from '../../data/repositories';
import DescriptionCard from './DescriptionCard';
import ReadmeCard from './ReadmeCard';
import type { FeedbackAction } from '../../api/activity';
import { FEEDBACK_ACTIONS } from '../../constants/feedbackActions';
import { FollowButton } from '../follow-button';
import {
  loadPinnedRepositories,
  pinnedRepositoryKey,
  setRepositoryPinned,
} from '../../services/pinnedRepositoryStorage';

type QueueActivity = (
  event: { repo_id: string; action: FeedbackAction; dwell_seconds?: number },
  flushNow?: boolean
) => void;

type ActionButtonProps = {
  accessibilityLabel: string;
  active?: boolean;
  activeColor?: string;
  count?: string;
  dense?: boolean;
  icon: React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
  iconSize?: number;
  label?: string;
  onPress: () => void;
};

function formatCount(value?: string) {
  if (!value) return '0';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (parsed >= 1_000_000) return `${(parsed / 1_000_000).toFixed(parsed >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (parsed >= 1_000) return `${(parsed / 1_000).toFixed(parsed >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(parsed);
}

function getInitials(owner: string) {
  return owner
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';
}

function ActionButton({
  accessibilityLabel,
  active = false,
  activeColor = REFERENCE_THEME.accent,
  count,
  dense = false,
  icon: Icon,
  iconSize = 29,
  label,
  onPress,
}: ActionButtonProps) {
  const colour = active ? activeColor : REFERENCE_THEME.text;
  const renderedIconSize = dense ? Math.min(iconSize, 22) : iconSize;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.actionButton,
        dense && styles.actionButtonDense,
        pressed && styles.actionPressed,
      ]}
    >
      <View style={[styles.iconShadow, dense && styles.iconShadowDense]}>
        <Icon color={colour} size={renderedIconSize} strokeWidth={1.9} />
      </View>
      <Text
        style={[
          styles.actionLabel,
          dense && styles.actionLabelDense,
          active && { color: activeColor },
        ]}
      >
        {count ?? label}
      </Text>
    </Pressable>
  );
}

export function RepositoryScreen({
  pageWidth,
  pageHeight,
  repository,
  isActive,
  isSaved,
  commentCount,
  onReadFullPress,
  onSavePress,
  onCommentPress,
  onOwnerPress,
  onQueueActivity,
}: {
  pageWidth: number;
  pageHeight: number;
  repository: RepositoryData;
  isActive?: boolean;
  isSaved?: boolean;
  commentCount?: number;
  onReadFullPress: () => void;
  onSavePress: () => void;
  onCommentPress: () => void;
  onOwnerPress?: () => void;
  onQueueActivity?: QueueActivity;
}) {
  const insets = useSafeAreaInsets();
  const { user, checkOnboardingStatus } = useAuth();
  const queryClient = useQueryClient();
  const compact = pageWidth < 360 || pageHeight < 720;
  const serverLiked = repository.viewerReaction === 'like';
  const serverDisliked = repository.viewerReaction === 'dislike';
  const [liked, setLiked] = React.useState(serverLiked);
  const [disliked, setDisliked] = React.useState(serverDisliked);
  const pinKey = pinnedRepositoryKey(repository);
  const pinnedRepositoriesQuery = useQuery({
    queryKey: ['pinned-repositories', user?.user_id],
    enabled: Boolean(user?.user_id),
    queryFn: () => loadPinnedRepositories(user!.user_id),
    staleTime: Infinity,
  });
  const storedPinned = pinnedRepositoriesQuery.data?.some((item) => item.key === pinKey) === true;
  const pinStateKey = `${pinKey}:${storedPinned}`;
  const [localPinState, setLocalPinState] = React.useState({ key: pinStateKey, pinned: storedPinned });
  const pinned = localPinState.key === pinStateKey ? localPinState.pinned : storedPinned;
  const pinMutation = useMutation<void, Error, boolean>({
    mutationFn: async (nextPinned) => {
      if (!user?.user_id) throw new Error('Sign in to pin repositories.');
      await setRepositoryPinned(user.user_id, repository, nextPinned);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['pinned-repositories', user?.user_id] });
    },
  });

  const initialLikes = Number(repository.stats.likes || 0) || 0;
  const likeCount = Math.max(0, initialLikes + Number(liked) - Number(serverLiked));
  const dislikeCount = disliked ? 1 : 0;
  const visibleCommentCount = (commentCount ?? Number(repository.stats.comments || 0)) || 0;
  const avatarColor = getAvatarColor(repository.ownerUserId || repository.owner);
  const normalizedOwner = repository.owner.trim().toLocaleLowerCase();
  const viewerGithubHandle = typeof user?.github_handle === 'string'
    ? user.github_handle.trim().toLocaleLowerCase()
    : '';
  const isViewerOwner = repository.ownerUserId === user?.user_id
    || (!repository.ownerUserId && Boolean(viewerGithubHandle) && normalizedOwner === viewerGithubHandle);
  const ownerFollowStateKnown = typeof repository.viewerFollowsOwner === 'boolean';
  const veryNarrow = pageWidth < 330;
  const veryShort = pageHeight < 620;
  const bodyTop = veryShort
    ? Math.max(80, insets.top + 52)
    : compact
      ? Math.max(96, insets.top + 62)
      : Math.max(116, insets.top + 70);
  const actionRailBottom = Math.max(insets.bottom, 10) + 8;
  const outerGutter = veryNarrow ? 10 : 14;
  const bodyLeft = outerGutter;
  const bodyRight = veryNarrow ? 52 : compact ? 58 : 64;
  const bodyBottom = veryShort ? 14 : compact ? 18 : 22;
  const availableCardWidth = Math.max(pageWidth - bodyLeft - bodyRight, 1);
  const bodyStyle: StyleProp<ViewStyle> = {
    paddingTop: bodyTop,
    paddingRight: bodyRight,
    paddingBottom: bodyBottom,
    paddingLeft: bodyLeft,
    gap: veryShort ? 3 : compact ? 5 : 14,
  };

  const toggleLike = () => {
    if (liked) {
      setLiked(false);
      onQueueActivity?.({ repo_id: repository.id, action: FEEDBACK_ACTIONS.unlike }, true);
      return;
    }
    setLiked(true);
    setDisliked(false);
    onQueueActivity?.({ repo_id: repository.id, action: FEEDBACK_ACTIONS.like }, true);
  };

  const toggleDislike = () => {
    if (disliked) {
      setDisliked(false);
      onQueueActivity?.({ repo_id: repository.id, action: FEEDBACK_ACTIONS.undislike }, true);
      return;
    }
    setDisliked(true);
    setLiked(false);
    onQueueActivity?.({ repo_id: repository.id, action: FEEDBACK_ACTIONS.dislike }, true);
  };

  const togglePinned = () => {
    if (pinMutation.isPending || !user?.user_id) return;
    const previous = pinned;
    const next = !previous;
    setLocalPinState({ key: pinStateKey, pinned: next });
    pinMutation.mutate(next, {
      onError: () => setLocalPinState({ key: pinStateKey, pinned: previous }),
    });
  };

  const shareRepository = async () => {
    onQueueActivity?.({ repo_id: repository.id, action: FEEDBACK_ACTIONS.share }, true);
    try {
      await Share.share({
        title: `${repository.owner}/${repository.title}`,
        message: `${repository.owner}/${repository.title}\n\n${repository.description}`,
      });
    } catch {
      // The native share sheet can be dismissed or unavailable without affecting the feed.
    }
  };

  return (
    <View style={[styles.screen, { width: pageWidth, height: pageHeight }]}>
      <View style={[styles.body, bodyStyle]}>
        <DescriptionCard
          availableWidth={availableCardWidth}
          repository={repository}
          compact={compact}
        />
        <ReadmeCard
          availableWidth={availableCardWidth}
          isActive={isActive}
          repository={repository}
          onReadFullPress={onReadFullPress}
          compact={compact}
        />

        <View style={[styles.repoDetails, compact && styles.repoDetailsCompact]}>
          <View style={[styles.ownerRow, compact && styles.ownerRowCompact]}>
            <Pressable
              accessibilityLabel={`View ${repository.owner}'s profile`}
              accessibilityRole="link"
              hitSlop={6}
              onPress={onOwnerPress}
              style={({ pressed }) => [
                styles.avatar,
                compact && styles.avatarCompact,
                { backgroundColor: avatarColor },
                pressed && styles.ownerPressed,
              ]}
            >
              <Text style={styles.avatarText}>{getInitials(repository.owner)}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={`View ${repository.owner}'s profile`}
              accessibilityRole="link"
              hitSlop={6}
              onPress={onOwnerPress}
              style={({ pressed }) => [styles.ownerHandleButton, pressed && styles.ownerPressed]}
            >
              <Text style={styles.ownerHandle} numberOfLines={1}>{repository.owner}</Text>
            </Pressable>
            {!isViewerOwner ? (
              <FollowButton
                compact={compact}
                identityKey={repository.owner}
                isFollowing={repository.viewerFollowsOwner === true}
                localOnly={user?.isPreview === true}
                neutral
                onFollowingChange={() => void checkOnboardingStatus()}
                stateKnown={ownerFollowStateKnown || user?.isPreview === true}
                targetUserId={repository.ownerUserId}
              />
            ) : null}
          </View>

          <Text
            style={[
              styles.repoTitle,
              styles.repoTitleSpacing,
              compact && styles.repoTitleCompact,
              compact && styles.repoTitleSpacingCompact,
            ]}
            numberOfLines={2}
          >
            {repository.title}
          </Text>
          <ScrollView
            style={[
              styles.descriptionScroller,
              compact && styles.descriptionScrollerCompact,
            ]}
            nestedScrollEnabled
            directionalLockEnabled
            bounces={false}
            overScrollMode="never"
            showsVerticalScrollIndicator
          >
            <Text style={[styles.description, compact && styles.descriptionCompact]}>
              {repository.description}
            </Text>
          </ScrollView>

          <View style={styles.repoStats}>
            <View
              accessible
              accessibilityLabel={`${formatCount(repository.stats.stars)} stars`}
              accessibilityRole="text"
              style={styles.statButton}
            >
              <Star
                size={17}
                color={REFERENCE_THEME.text}
                strokeWidth={1.9}
              />
              <Text style={styles.statText}>
                {formatCount(repository.stats.stars)}
              </Text>
            </View>
            <View
              accessible
              accessibilityLabel={`${formatCount(repository.stats.forks)} forks`}
              accessibilityRole="text"
              style={styles.statButton}
            >
              <GitFork size={16} color={REFERENCE_THEME.text} strokeWidth={1.9} />
              <Text style={styles.statText}>{formatCount(repository.stats.forks)}</Text>
            </View>
            <View accessibilityLabel={`${formatCount(repository.stats.views)} views`} style={styles.statButton}>
              <Eye size={16} color={REFERENCE_THEME.text} strokeWidth={1.9} />
              <Text style={styles.statText}>{formatCount(repository.stats.views)}</Text>
            </View>
            <View accessibilityLabel={`${formatCount(repository.stats.bugs)} open issues`} style={styles.statButton}>
              <CircleAlert size={16} color={REFERENCE_THEME.text} strokeWidth={1.9} />
              <Text style={styles.statText}>{formatCount(repository.stats.bugs)}</Text>
            </View>
          </View>
        </View>
      </View>

      <View
        style={[
          styles.actionRail,
          compact && styles.actionRailCompact,
          {
            bottom: actionRailBottom,
            gap: veryShort ? 6 : compact ? 12 : 19,
            right: outerGutter,
          },
        ]}
      >
        <ActionButton
          accessibilityLabel={liked ? 'Unlike repository' : 'Like repository'}
          active={liked}
          count={formatCount(String(likeCount))}
          dense={veryShort}
          icon={ThumbsUp}
          onPress={toggleLike}
        />
        <ActionButton
          accessibilityLabel={disliked ? 'Remove dislike' : 'Dislike repository'}
          active={disliked}
          activeColor={REFERENCE_THEME.danger}
          count={formatCount(String(dislikeCount))}
          dense={veryShort}
          icon={ThumbsDown}
          onPress={toggleDislike}
        />
        <ActionButton
          accessibilityLabel="Open comments"
          count={formatCount(String(visibleCommentCount))}
          dense={veryShort}
          icon={MessageCircle}
          onPress={onCommentPress}
        />
        <ActionButton
          accessibilityLabel="Save repository"
          active={isSaved}
          dense={veryShort}
          icon={Bookmark}
          iconSize={26}
          label="Save"
          onPress={onSavePress}
        />
        <ActionButton
          accessibilityLabel={pinned ? 'Unpin repository' : 'Pin repository'}
          active={pinned}
          activeColor="#1EE15B"
          dense={veryShort}
          icon={Pin}
          iconSize={26}
          label="Pin"
          onPress={togglePinned}
        />
        <ActionButton
          accessibilityLabel="Share repository"
          dense={veryShort}
          icon={ShareIcon}
          iconSize={28}
          label="Share"
          onPress={shareRepository}
        />
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: REFERENCE_THEME.background,
  },
  body: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'column',
  },
  ownerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    gap: 7,
  },
  ownerRowCompact: {
    gap: 6,
  },
  repoDetails: {
    marginTop: 'auto',
    paddingTop: 8,
    gap: 14,
  },
  repoDetailsCompact: {
    paddingTop: 5,
    gap: 8,
  },
  avatar: {
    width: 37,
    height: 37,
    borderRadius: 18.5,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarCompact: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  avatarText: {
    position: 'absolute',
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 13,
    lineHeight: 18,
  },
  ownerHandle: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 14.5,
    lineHeight: 19,
    letterSpacing: -0.2,
  },
  ownerHandleButton: {
    flexShrink: 1,
    minWidth: 0,
  },
  ownerPressed: {
    opacity: 0.65,
    transform: [{ scale: 0.97 }],
  },
  repoTitle: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 25,
    lineHeight: 29,
    letterSpacing: -0.7,
  },
  repoTitleSpacing: {
    marginTop: -6,
  },
  repoTitleCompact: {
    fontSize: 19,
    lineHeight: 23,
  },
  repoTitleSpacingCompact: {
    marginTop: -3,
  },
  descriptionScroller: {
    maxHeight: 42,
    marginTop: -6,
  },
  descriptionScrollerCompact: {
    maxHeight: 32,
    marginTop: -3,
  },
  description: {
    color: 'rgba(235,235,245,0.72)',
    fontFamily: 'NataSans-Regular',
    fontSize: 14,
    lineHeight: 21,
    letterSpacing: -0.1,
  },
  descriptionCompact: {
    fontSize: 11.5,
    lineHeight: 16,
  },
  repoStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 14,
    rowGap: 4,
  },
  statButton: {
    minWidth: 34,
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
  },
  statText: {
    color: 'rgba(255,255,255,0.92)',
    fontFamily: 'NataSans-SemiBold',
    fontSize: 13,
    lineHeight: 17,
  },
  actionRail: {
    position: 'absolute',
    right: 14,
    zIndex: 5,
    alignItems: 'center',
    gap: 19,
  },
  actionRailCompact: {
    right: 10,
    gap: 12,
  },
  actionButton: {
    minWidth: 40,
    alignItems: 'center',
    gap: 4,
  },
  actionButtonDense: {
    minWidth: 34,
    gap: 2,
  },
  actionPressed: {
    transform: [{ scale: 0.86 }],
  },
  iconShadow: {
    width: 40,
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.55,
    shadowRadius: 8,
    elevation: 3,
  },
  iconShadowDense: {
    width: 34,
  },
  actionLabel: {
    width: 40,
    color: 'rgba(255,255,255,0.92)',
    fontFamily: 'NataSans-SemiBold',
    fontSize: 11.5,
    lineHeight: 15,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
    textAlign: 'center',
  },
  actionLabelDense: {
    width: 34,
    fontSize: 9.5,
    lineHeight: 12,
  },
});
