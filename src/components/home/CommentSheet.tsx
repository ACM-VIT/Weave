import { useReducedMotion } from 'react-native-reanimated';
import { KeyboardSurface } from '@/components/keyboard/keyboard-layout';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Image,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { ArrowUp, MessageCircle, RotateCcw, X } from 'lucide-react-native';
import { BlurView } from 'expo-blur';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import {
  createComment,
  getCommentAuthor,
  getCommentsByRepo,
  type CommentAuthor,
  type CommentRecord,
} from '../../api/comments';
import { REFERENCE_THEME } from '../../constants/theme';
import { useAuth } from '../../store/AuthContext';
import * as SecureStore from '../../utils/storage';

const OPEN_DURATION = 280;
const CLOSE_DURATION = 220;
const OVERLAY_DURATION = 200;
const SHEET_EASING = Easing.bezier(0.32, 0.72, 0, 1);

type OptimisticContext = {
  optimisticId: string;
  previousComments: CommentRecord[];
  previousCount: number;
  submittedText: string;
};

export interface CommentSheetProps {
  isVisible: boolean;
  onClose: () => void;
  repoId: string;
  initialCommentCount?: number;
  onCommentCountChange?: (count: number) => void;
}

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return 'now';

  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return 'now';

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (elapsedSeconds < 60) return 'now';
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)}h`;
  if (elapsedSeconds < 604800) return `${Math.floor(elapsedSeconds / 86400)}d`;

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function avatarGradient(seed: string): readonly [string, string] {
  const colors = [
    ['#5E5CE6', '#BF5AF2'],
    ['#64D2FF', '#2A7FBF'],
    ['#FF6482', '#C93A56'],
    ['#63E6A9', '#2E9E6B'],
    ['#FFB340', '#E08700'],
  ] as const;
  const hash = Array.from(seed).reduce((value, char) => value + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

function fallbackHandle(userId: string): string {
  const compactId = userId.replace(/-/g, '');
  return `@user_${compactId.slice(0, 6) || 'unknown'}`;
}

function CommentAvatar({ author, userId }: { author?: CommentAuthor; userId: string }) {
  const handle = author?.username || fallbackHandle(userId).slice(1);
  const initial = handle.trim().charAt(0).toUpperCase() || '?';
  const [start, end] = avatarGradient(userId);

  if (author?.avatar_url) {
    return <Image source={{ uri: author.avatar_url }} style={styles.avatar} />;
  }

  return (
    <View style={styles.avatar}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <LinearGradient id="commentAvatar" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={start} />
            <Stop offset="1" stopColor={end} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#commentAvatar)" />
      </Svg>
      <Text style={styles.avatarInitial}>{initial}</Text>
    </View>
  );
}

export function CommentSheet({
  isVisible,
  onClose,
  repoId,
  initialCommentCount = 0,
  onCommentCountChange,
}: CommentSheetProps) {
  const { height, width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['comments', repoId] as const, [repoId]);

  const overlayOpacity = useMemo(() => new Animated.Value(0), []);
  const sheetTranslateY = useMemo(() => new Animated.Value(0), []);
  const closingRef = useRef(false);
  const listRef = useRef<FlatList<CommentRecord>>(null);

  const [draft, setDraft] = useState('');
  const [composerError, setComposerError] = useState<string | null>(null);
  const [localCountFloorByRepo, setLocalCountFloorByRepo] = useState<Record<string, number>>({});

  const commentsQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => getCommentsByRepo(repoId, signal),
    enabled: isVisible && repoId.trim().length > 0,
    staleTime: 30_000,
  });

  const comments = useMemo(() => commentsQuery.data ?? [], [commentsQuery.data]);
  const authorIds = useMemo(
    () =>
      Array.from(new Set(comments.map((comment) => comment.user_id)))
        .filter((userId) => userId !== user?.user_id
          && !comments.some((comment) => comment.user_id === userId && comment.author))
        .sort(),
    [comments, user?.user_id],
  );

  const authorsQuery = useQuery({
    queryKey: ['comment-authors', authorIds],
    queryFn: async ({ signal }) => {
      const entries = await Promise.all(
        authorIds.map(async (userId) => {
          try {
            const author = await getCommentAuthor(userId, signal);
            return [userId, author] as const;
          } catch (error) {
            if (signal.aborted) throw error;
            return [userId, undefined] as const;
          }
        }),
      );

      return Object.fromEntries(entries) as Record<string, CommentAuthor | undefined>;
    },
    enabled: isVisible && authorIds.length > 0,
    staleTime: 5 * 60_000,
  });

  const currentAuthor = useMemo<CommentAuthor | undefined>(() => {
    if (!user?.user_id || !user.username) return undefined;

    return {
      user_id: user.user_id,
      username: user.username,
      full_name: typeof user.full_name === 'string' ? user.full_name : null,
      avatar_url: typeof user.avatar_url === 'string' ? user.avatar_url : null,
    };
  }, [user]);

  const authorById = useMemo(() => {
    const authors = Object.fromEntries(
      comments
        .filter((comment) => comment.author)
        .map((comment) => [comment.user_id, comment.author]),
    ) as Record<string, CommentAuthor | undefined>;
    Object.assign(authors, authorsQuery.data ?? {});
    if (currentAuthor) authors[currentAuthor.user_id] = currentAuthor;
    return authors;
  }, [authorsQuery.data, comments, currentAuthor]);

  useEffect(() => {
    if (!isVisible) return;

    closingRef.current = false;
    overlayOpacity.setValue(0);
    sheetTranslateY.setValue(height * 0.75);

    Animated.parallel([
      Animated.timing(overlayOpacity, {
        toValue: 1,
        duration: reducedMotion ? 0 : OVERLAY_DURATION,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(sheetTranslateY, {
        toValue: 0,
        duration: reducedMotion ? 0 : OPEN_DURATION,
        easing: SHEET_EASING,
        useNativeDriver: true,
      }),
    ]).start();
  }, [height, isVisible, overlayOpacity, sheetTranslateY, reducedMotion]);

  const closeAnimated = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    Keyboard.dismiss();

    Animated.parallel([
      Animated.timing(overlayOpacity, {
        toValue: 0,
        duration: reducedMotion ? 0 : OVERLAY_DURATION,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(sheetTranslateY, {
        toValue: height * 0.75,
        duration: reducedMotion ? 0 : CLOSE_DURATION,
        easing: SHEET_EASING,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      closingRef.current = false;
      if (finished) onClose();
    });
  }, [height, onClose, overlayOpacity, sheetTranslateY, reducedMotion]);

  const createMutation = useMutation<CommentRecord, Error, string, OptimisticContext>({
    mutationFn: async (text) => {
      if (!user?.user_id) throw new Error('Sign in to leave a comment');

      const token = await SecureStore.getItemAsync('access_token');
      if (!token) throw new Error('Your session has expired. Please sign in again.');

      return createComment(
        {
          repoId,
          comment: text,
        },
        token,
      );
    },
    onMutate: async (submittedText) => {
      await queryClient.cancelQueries({ queryKey });

      const previousComments = queryClient.getQueryData<CommentRecord[]>(queryKey) ?? [];
      const previousCount = Math.max(initialCommentCount, previousComments.length);
      const optimisticId = `optimistic-${Date.now()}`;
      const optimisticComment: CommentRecord = {
        comment_id: optimisticId,
        user_id: user?.user_id ?? 'unknown',
        repo_id: repoId,
        parent_comment_id: null,
        comment: submittedText.trim(),
        created_at: new Date().toISOString(),
      };

      queryClient.setQueryData<CommentRecord[]>(queryKey, [
        ...previousComments,
        optimisticComment,
      ]);
      setLocalCountFloorByRepo((current) => ({
        ...current,
        [repoId]: previousCount + 1,
      }));
      setDraft('');
      setComposerError(null);
      onCommentCountChange?.(previousCount + 1);
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });

      return {
        optimisticId,
        previousComments,
        previousCount,
        submittedText,
      };
    },
    onSuccess: (savedComment, _submittedText, context) => {
      queryClient.setQueryData<CommentRecord[]>(queryKey, (current = []) =>
        current.map((comment) =>
          comment.comment_id === context.optimisticId ? savedComment : comment,
        ),
      );
    },
    onError: (error, submittedText, context) => {
      if (context) {
        queryClient.setQueryData(queryKey, context.previousComments);
        setLocalCountFloorByRepo((current) => ({
          ...current,
          [repoId]: context.previousCount,
        }));
        onCommentCountChange?.(context.previousCount);
      }
      setDraft(context?.submittedText ?? submittedText);
      setComposerError(error.message);
    },
  });

  const submitComment = useCallback(() => {
    const normalizedDraft = draft.trim();
    if (!normalizedDraft || createMutation.isPending) return;
    createMutation.mutate(normalizedDraft);
  }, [createMutation, draft]);

  const displayedCount = Math.max(
    initialCommentCount,
    localCountFloorByRepo[repoId] ?? 0,
    comments.length,
  );
  const composerDisabled = !draft.trim() || createMutation.isPending || !user?.user_id;

  const renderComment = useCallback(
    ({ item }: { item: CommentRecord }) => {
      const author = authorById[item.user_id];
      const handle = author?.username
        ? `@${author.username.replace(/^@/, '')}`
        : fallbackHandle(item.user_id);
      return (
        <View style={styles.commentRow}>
          <CommentAvatar author={author} userId={item.user_id} />
          <View style={styles.commentContent}>
            <View style={styles.commentMeta}>
              <Text numberOfLines={1} style={styles.handle}>
                {handle}
              </Text>
              <Text style={styles.timestamp}>{formatRelativeTime(item.created_at)}</Text>
            </View>
            <Text style={styles.commentBody}>{item.comment}</Text>
          </View>
        </View>
      );
    },
    [authorById],
  );

  const emptyState = (() => {
    if (commentsQuery.isLoading) {
      return (
        <View style={styles.stateContainer}>
          <ActivityIndicator color={REFERENCE_THEME.accent} size="small" />
          <Text style={styles.stateText}>Loading comments...</Text>
        </View>
      );
    }

    if (commentsQuery.isError) {
      return (
        <View style={styles.stateContainer}>
          <Text style={styles.stateTitle}>Comments could not load</Text>
          <Text style={styles.stateText}>Check your connection and try again.</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => commentsQuery.refetch()}
            style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
          >
            <RotateCcw color={REFERENCE_THEME.accent} size={14} strokeWidth={2} />
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <View style={styles.stateContainer}>
        <MessageCircle color={REFERENCE_THEME.textTertiary} size={28} strokeWidth={1.5} />
        <Text style={styles.stateTitle}>No comments yet</Text>
        <Text style={styles.stateText}>Start the conversation.</Text>
      </View>
    );
  })();

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={closeAnimated}
      statusBarTranslucent
      transparent
      visible={isVisible}
    >
      <View style={styles.modalRoot}>
        <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
          <BlurView intensity={12} tint="dark" style={StyleSheet.absoluteFill} />
          <Pressable
            accessibilityLabel="Close comments"
            onPress={closeAnimated}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>

        <KeyboardSurface
          pointerEvents="box-none"
          style={[styles.keyboardRoot, { paddingTop: insets.top }]}
        >
          <Animated.View
            style={[
              styles.sheet,
              { flexShrink: 1, minHeight: 0 },
              {
                width: Math.min(width, 520),
                height: Math.floor(height * 0.75),
                transform: [{ translateY: sheetTranslateY }],
              },
            ]}
          >
            <View style={styles.grabberWrap}>
              <View style={styles.grabber} />
            </View>

            <View style={styles.header}>
              <View style={styles.titleRow}>
                <Text style={styles.title}>Comments</Text>
                <Text style={styles.count}>{displayedCount}</Text>
              </View>
              <Pressable
                accessibilityLabel="Close comments"
                accessibilityRole="button"
                hitSlop={14}
                onPress={closeAnimated}
                style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
              >
                <X color="rgba(235,235,245,0.70)" size={12} strokeWidth={2.6} />
              </Pressable>
            </View>

            <View style={styles.separator} />

            <FlatList
              ref={listRef}
              contentContainerStyle={[
                styles.listContent,
                comments.length === 0 && styles.emptyListContent,
              ]}
              data={comments}
              ItemSeparatorComponent={() => <View style={styles.commentGap} />}
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              keyboardShouldPersistTaps="handled"
              keyExtractor={(item) => item.comment_id}
              ListEmptyComponent={emptyState}
              renderItem={renderComment}
              showsVerticalScrollIndicator={false}
              style={styles.list}
            />

            <View
              style={[
                styles.composer,
                { paddingBottom: Math.max(insets.bottom, 28) },
              ]}
            >
              {composerError ? (
                <Text accessibilityRole="alert" style={styles.composerError}>
                  {composerError}
                </Text>
              ) : null}
              <View style={styles.composerRow}>
                <CommentAvatar author={currentAuthor} userId={user?.user_id ?? 'guest'} />
                <TextInput
                  accessibilityLabel="Add a comment"
                  editable={!!user?.user_id && !createMutation.isPending}
                  maxLength={1000}
                  onChangeText={(text) => {
                    setDraft(text);
                    if (composerError) setComposerError(null);
                  }}
                  onSubmitEditing={submitComment}
                  placeholder={user?.user_id ? 'Add a comment...' : 'Sign in to comment'}
                  placeholderTextColor={REFERENCE_THEME.textSecondary}
                  returnKeyType="send"
                  style={styles.input}
                  value={draft}
                />
                <Pressable
                  accessibilityLabel="Send comment"
                  accessibilityRole="button"
                  disabled={composerDisabled}
                  onPress={submitComment}
                  style={({ pressed }) => [
                    styles.sendButton,
                    composerDisabled && styles.sendButtonDisabled,
                    pressed && !composerDisabled && styles.sendButtonPressed,
                  ]}
                >
                  {createMutation.isPending ? (
                    <ActivityIndicator color={REFERENCE_THEME.text} size="small" />
                  ) : (
                    <ArrowUp
                      color={composerDisabled ? REFERENCE_THEME.textDisabled : REFERENCE_THEME.text}
                      size={20}
                      strokeWidth={2.5}
                    />
                  )}
                </Pressable>
              </View>
            </View>
          </Animated.View>
        </KeyboardSurface>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  overlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  keyboardRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  sheet: {
    width: '100%',
    backgroundColor: '#1C1C1E',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.28,
    shadowRadius: 20,
    elevation: 24,
  },
  grabberWrap: {
    height: 14,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: 'rgba(235,235,245,0.20)',
  },
  header: {
    minHeight: 44,
    paddingTop: 4,
    paddingHorizontal: 20,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  title: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 15,
    lineHeight: 20,
  },
  count: {
    color: REFERENCE_THEME.textTertiary,
    fontFamily: 'NataSans-Medium',
    fontSize: 12.5,
    lineHeight: 18,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 13,
    backgroundColor: REFERENCE_THEME.controlStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: REFERENCE_THEME.separator,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  commentGap: {
    height: 17,
  },
  commentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 13,
  },
  commentContent: {
    flex: 1,
    minWidth: 0,
    marginLeft: 11,
  },
  commentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 3,
  },
  handle: {
    maxWidth: '74%',
    color: REFERENCE_THEME.textStrong,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 12.5,
    lineHeight: 17,
  },
  timestamp: {
    color: REFERENCE_THEME.textTertiary,
    fontFamily: 'NataSans-Regular',
    fontSize: 11.5,
    lineHeight: 16,
  },
  commentBody: {
    color: REFERENCE_THEME.textPrimary,
    fontFamily: 'NataSans-Regular',
    fontSize: 13.5,
    lineHeight: 19.6,
  },
  stateContainer: {
    flex: 1,
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
    gap: 7,
  },
  stateTitle: {
    color: REFERENCE_THEME.textStrong,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 14,
    lineHeight: 19,
    textAlign: 'center',
  },
  stateText: {
    color: REFERENCE_THEME.textTertiary,
    fontFamily: 'NataSans-Regular',
    fontSize: 12.5,
    lineHeight: 18,
    textAlign: 'center',
  },
  retryButton: {
    minHeight: 32,
    marginTop: 5,
    paddingHorizontal: 12,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: REFERENCE_THEME.control,
  },
  retryText: {
    color: REFERENCE_THEME.accent,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 12,
  },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: REFERENCE_THEME.separator,
    paddingTop: 12,
    paddingHorizontal: 16,
    backgroundColor: '#1C1C1E',
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  composerError: {
    color: REFERENCE_THEME.danger,
    fontFamily: 'NataSans-Regular',
    fontSize: 11.5,
    lineHeight: 16,
    marginBottom: 7,
    paddingHorizontal: 3,
  },
  input: {
    flex: 1,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(118,118,128,0.18)',
    color: REFERENCE_THEME.textStrong,
    fontFamily: 'NataSans-Regular',
    fontSize: 13.5,
    lineHeight: 18,
    paddingHorizontal: 15,
    paddingVertical: 0,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#30D158',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: REFERENCE_THEME.control,
  },
  sendButtonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.96 }],
  },
  pressed: {
    opacity: 0.65,
  },
});

export default CommentSheet;
