import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Linking,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import * as ExpoLinking from 'expo-linking';
import * as Haptics from 'expo-haptics';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Check,
  Copy,
  ExternalLink,
  RotateCcw,
  Share2,
  X,
} from 'lucide-react-native';

import {
  fetchRepositoryDetail,
  repositoryDetailQueryKey,
} from '@/api/repositories';
import { REFERENCE_THEME } from '@/constants/theme';
import { useModalScrollLock } from '@/hooks/use-modal-scroll-lock';
import type { RepositoryDetail } from '@/models/repository';
import { useAuth } from '@/store/AuthContext';
import { getStorageItem } from '@/utils/storage';
import {
  buildRepositoryShareContent,
  repositoryPath,
  resolveRepositoryShareUrl,
} from '@/utils/repository-links';
import { shareResultConfirmsCompletion } from '@/utils/share-feedback';

type ShareRepositorySheetProps = {
  isVisible: boolean;
  onClose: () => void;
  onShared?: () => void;
  repositoryId: string;
  repositoryDetails?: Pick<
    RepositoryDetail,
    'id' | 'fullName' | 'githubUrl' | 'description'
  >;
};

const configuredWebUrl = process.env.EXPO_PUBLIC_WEB_URL;

const palette = {
  background: REFERENCE_THEME.surface,
  elevated: REFERENCE_THEME.surfaceElevated,
  elevatedMuted: '#242426',
  border: REFERENCE_THEME.border,
  text: REFERENCE_THEME.text,
  secondary: REFERENCE_THEME.textSecondary,
  accent: REFERENCE_THEME.accent,
  accentText: '#07130A',
  overlay: 'rgba(0,0,0,0.70)',
};

function githubRepositoryUrl(value: string | null | undefined): string | null {
  if (!value || !/^https:\/\/github\.com\//i.test(value)) return null;
  return value;
}

export function ShareRepositorySheet({
  isVisible,
  onClose,
  onShared,
  repositoryId,
  repositoryDetails,
}: ShareRepositorySheetProps) {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const viewerUserId = user?.user_id;
  const sheetMaxHeight = Math.min(500, height * 0.82);
  const [translateY] = useState(() => new Animated.Value(height));
  const [overlayOpacity] = useState(() => new Animated.Value(0));
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useModalScrollLock(isVisible);

  const repositoryQuery = useQuery({
    queryKey: repositoryDetailQueryKey(repositoryId, viewerUserId),
    queryFn: async ({ signal }) => {
      const token = await getStorageItem('access_token');
      if (!token) throw new Error('Sign in to load repository details.');
      return fetchRepositoryDetail(repositoryId, token, signal);
    },
    enabled: isVisible && Boolean(repositoryId && viewerUserId) && !repositoryDetails,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    retryDelay: 500,
  });

  const details = repositoryDetails ?? repositoryQuery.data;
  const githubUrl = githubRepositoryUrl(details?.githubUrl);
  const linkLoading = !details && (repositoryQuery.isLoading || repositoryQuery.isFetching);
  const linkFailed = !details && repositoryQuery.isError;
  const weaveUrl = useMemo(() => {
    try {
      const path = repositoryPath(repositoryId);
      const nativeUrl = ExpoLinking.createURL(path.slice(1));
      return resolveRepositoryShareUrl({
        repoId: repositoryId,
        webBaseUrl: configuredWebUrl,
        nativeUrl,
      });
    } catch {
      return null;
    }
  }, [repositoryId]);
  const shareContent = useMemo(() => weaveUrl
    ? buildRepositoryShareContent(details?.fullName, weaveUrl)
    : null, [details?.fullName, weaveUrl]);

  const haptic = useCallback(async (kind: 'selection' | 'success' = 'selection') => {
    if (process.env.EXPO_OS === 'web') return;
    if (kind === 'success') {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } else {
      await Haptics.selectionAsync().catch(() => undefined);
    }
  }, []);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  }, []);

  const closeAnimated = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: height,
        duration: 210,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(overlayOpacity, {
        toValue: 0,
        duration: 170,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (!finished) return;
      setToast('');
      onClose();
    });
  }, [height, onClose, overlayOpacity, translateY]);

  useEffect(() => {
    if (!isVisible) return;
    translateY.setValue(height);
    overlayOpacity.setValue(0);
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: 290,
        easing: Easing.bezier(0.32, 0.72, 0, 1),
        useNativeDriver: true,
      }),
      Animated.timing(overlayOpacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [height, isVisible, overlayOpacity, translateY]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const copyWeaveLink = useCallback(async () => {
    if (!weaveUrl) throw new Error('Weave link is unavailable.');
    const copied = await Clipboard.setStringAsync(weaveUrl);
    if (!copied) throw new Error('Unable to copy the Weave link.');
    await haptic('success');
    showToast('Weave link copied');
    onShared?.();
  }, [haptic, onShared, showToast, weaveUrl]);

  const shareWeaveLink = useCallback(async () => {
    if (!shareContent) throw new Error('Weave link is unavailable.');
    await haptic();
    const result = await Share.share(shareContent);
    if (shareResultConfirmsCompletion(
      process.env.EXPO_OS ?? 'unknown',
      result.action,
      Share.sharedAction,
    )) {
      onShared?.();
    }
  }, [haptic, onShared, shareContent]);

  const openOnGithub = useCallback(async () => {
    if (!githubUrl) throw new Error('GitHub link is unavailable.');
    await haptic();
    await Linking.openURL(githubUrl);
  }, [githubUrl, haptic]);

  if (!isVisible) return null;

  const shareUnavailable = !shareContent;

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={closeAnimated}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <View style={styles.root}>
        <Pressable
          accessibilityLabel="Close share sheet"
          accessibilityRole="button"
          onPress={closeAnimated}
          style={StyleSheet.absoluteFill}
        >
          <Animated.View style={[styles.overlay, {
            backgroundColor: palette.overlay,
            opacity: overlayOpacity,
          }]}
          >
            <BlurView intensity={22} tint="dark" style={StyleSheet.absoluteFill} />
          </Animated.View>
        </Pressable>

        <View pointerEvents="box-none" style={styles.sheetLayer}>
          <Animated.View
            style={[
              styles.sheet,
              {
                backgroundColor: palette.background,
                borderColor: palette.border,
                marginBottom: Math.max(insets.bottom, 12),
                maxHeight: sheetMaxHeight,
                transform: [{ translateY }],
                width: Math.min(Math.max(width - 24, 0), 460),
              },
            ]}
          >
            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text selectable style={[styles.title, { color: palette.text }]}>Share repository</Text>
                <Text selectable style={[styles.subtitle, { color: palette.secondary }]}>Share a link that opens this repository in Weave.</Text>
              </View>
              <Pressable
                accessibilityLabel="Close"
                accessibilityRole="button"
                hitSlop={8}
                onPress={closeAnimated}
                style={[styles.closeButton, { backgroundColor: palette.elevated }]}
              >
                <X color={palette.secondary} size={18} />
              </Pressable>
            </View>

            <View style={styles.actions}>
              <View
                accessibilityLiveRegion="polite"
                style={[styles.linkCard, {
                  backgroundColor: palette.elevatedMuted,
                  borderColor: palette.border,
                }]}
              >
                <View style={styles.linkCopy}>
                  <Text numberOfLines={1} selectable style={[styles.linkName, { color: palette.text }]}>
                    {details?.fullName ?? (linkLoading ? 'Loading repository…' : 'Weave repository')}
                  </Text>
                  <Text numberOfLines={2} selectable style={[styles.linkUrl, { color: palette.secondary }]}>
                    {weaveUrl ?? 'Weave link unavailable'}
                  </Text>
                </View>
                {linkLoading ? (
                  <View accessibilityLabel="Loading repository details" style={styles.linkStatusAction}>
                    <ActivityIndicator color={palette.accent} size="small" />
                  </View>
                ) : linkFailed ? (
                  <Pressable
                    accessibilityLabel="Retry loading repository details"
                    accessibilityRole="button"
                    onPress={() => repositoryQuery.refetch()}
                    style={({ pressed }) => [
                      styles.linkStatusAction,
                      { borderColor: palette.border },
                      pressed && styles.pressed,
                    ]}
                  >
                    <RotateCcw color={palette.accent} size={17} />
                  </Pressable>
                ) : null}
              </View>

              <View style={styles.primaryActions}>
                <Pressable
                  accessibilityLabel="Share Weave repository link"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: shareUnavailable }}
                  disabled={shareUnavailable}
                  onPress={() => void shareWeaveLink().catch((error) => {
                    showToast(error instanceof Error ? error.message : 'Unable to share the Weave link.');
                  })}
                  style={({ pressed }) => [
                    styles.primaryAction,
                    { backgroundColor: palette.accent },
                    shareUnavailable && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Share2 color={palette.accentText} size={21} strokeWidth={2.1} />
                  <Text style={[styles.primaryActionText, { color: palette.accentText }]}>Share</Text>
                </Pressable>

                <Pressable
                  accessibilityLabel="Copy Weave repository link"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !weaveUrl }}
                  disabled={!weaveUrl}
                  onPress={() => void copyWeaveLink().catch((error) => {
                    showToast(error instanceof Error ? error.message : 'Unable to copy the Weave link.');
                  })}
                  style={({ pressed }) => [
                    styles.primaryAction,
                    { backgroundColor: palette.elevatedMuted, borderColor: palette.border, borderWidth: 1 },
                    !weaveUrl && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Copy color={palette.accent} size={21} strokeWidth={2.1} />
                  <Text style={[styles.primaryActionText, { color: palette.text }]}>Copy Weave Link</Text>
                </Pressable>
              </View>

              <Pressable
                accessibilityHint="Leaves Weave and opens the repository on github.com"
                accessibilityLabel="Open on GitHub"
                accessibilityRole="link"
                accessibilityState={{ disabled: !githubUrl }}
                disabled={!githubUrl}
                onPress={() => void openOnGithub().catch((error) => {
                  showToast(error instanceof Error ? error.message : 'Unable to open GitHub.');
                })}
                style={({ pressed }) => [
                  styles.githubAction,
                  { borderColor: palette.border },
                  !githubUrl && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <ExternalLink color={palette.secondary} size={19} strokeWidth={1.9} />
                <View style={styles.githubActionCopy}>
                  <Text style={[styles.githubActionTitle, { color: palette.text }]}>Open on GitHub</Text>
                  <Text style={[styles.githubActionSubtitle, { color: palette.secondary }]}>External link</Text>
                </View>
              </Pressable>
            </View>

            {toast ? (
              <View
                accessibilityLiveRegion="polite"
                style={[styles.toast, {
                  backgroundColor: palette.elevated,
                  borderColor: palette.border,
                }]}
              >
                <Check color={palette.accent} size={17} strokeWidth={2.4} />
                <Text selectable style={[styles.toastText, { color: palette.text }]}>{toast}</Text>
              </View>
            ) : null}
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  overlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
  sheetLayer: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  sheet: {
    borderRadius: 26,
    borderWidth: 1,
    overflow: 'hidden',
    boxShadow: '0 22px 64px rgba(0,0,0,0.48)',
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  headerText: { flex: 1, gap: 3 },
  title: { fontFamily: 'NataSans-Bold', fontSize: 19, lineHeight: 24 },
  subtitle: { fontFamily: 'NataSans-Regular', fontSize: 12, lineHeight: 17 },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: { paddingHorizontal: 14, paddingBottom: 16, gap: 12 },
  linkCard: {
    minHeight: 68,
    borderWidth: 1,
    borderRadius: 16,
    padding: 11,
    paddingLeft: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  linkCopy: { flex: 1, minWidth: 0, gap: 2 },
  linkName: { fontFamily: 'NataSans-SemiBold', fontSize: 13.5, lineHeight: 18 },
  linkUrl: { fontFamily: 'NataSans-Regular', fontSize: 10.5, lineHeight: 15 },
  linkStatusAction: {
    width: 38,
    height: 38,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActions: { flexDirection: 'row', gap: 10 },
  primaryAction: {
    flex: 1,
    minHeight: 72,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  primaryActionText: {
    fontFamily: 'NataSans-Bold',
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  githubAction: {
    minHeight: 54,
    borderWidth: 1,
    borderRadius: 15,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  githubActionCopy: { flex: 1, gap: 1 },
  githubActionTitle: { fontFamily: 'NataSans-SemiBold', fontSize: 13, lineHeight: 17 },
  githubActionSubtitle: { fontFamily: 'NataSans-Regular', fontSize: 10.5, lineHeight: 14 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.45 },
  toast: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 14,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 13,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  toastText: { fontFamily: 'NataSans-SemiBold', fontSize: 12 },
});
