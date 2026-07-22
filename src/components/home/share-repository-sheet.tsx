import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import {
  AtSign,
  BriefcaseBusiness,
  Check,
  Copy,
  Hash,
  Network,
  Mail,
  MessageCircle,
  QrCode,
  RotateCcw,
  Send,
  Share2,
  X,
} from 'lucide-react-native';

import {
  getRepositoryShareDetails,
  type RepositoryShareDetails,
} from '@/api/repository-actions';
import { REFERENCE_THEME } from '@/constants/theme';
import { useModalScrollLock } from '@/hooks/use-modal-scroll-lock';

type ShareRepositorySheetProps = {
  isVisible: boolean;
  onClose: () => void;
  onShared?: () => void;
  repositoryId: string;
  repositoryDetails?: RepositoryShareDetails;
};

type ShareActionId = 'copy' | 'system' | 'whatsapp' | 'telegram'
  | 'discord' | 'slack' | 'x' | 'linkedin' | 'email' | 'qr';

type Action = {
  id: ShareActionId;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
};

const APP_ACTIONS: Action[] = [
  { id: 'whatsapp', label: 'Share to WhatsApp', shortLabel: 'WhatsApp', icon: MessageCircle },
  { id: 'telegram', label: 'Share to Telegram', shortLabel: 'Telegram', icon: Send },
  { id: 'discord', label: 'Share to Discord', shortLabel: 'Discord', icon: Hash },
  { id: 'slack', label: 'Share to Slack', shortLabel: 'Slack', icon: AtSign },
  { id: 'x', label: 'Share to X', shortLabel: 'X', icon: BriefcaseBusiness },
  { id: 'linkedin', label: 'Share to LinkedIn', shortLabel: 'LinkedIn', icon: Network },
  { id: 'email', label: 'Share via email', shortLabel: 'Email', icon: Mail },
  { id: 'system', label: 'Open system share options', shortLabel: 'More', icon: Share2 },
  { id: 'qr', label: 'Generate QR code', shortLabel: 'QR code', icon: QrCode },
];

const palette = {
  background: REFERENCE_THEME.surface,
  elevated: REFERENCE_THEME.surfaceElevated,
  elevatedMuted: '#242426',
  border: REFERENCE_THEME.border,
  text: REFERENCE_THEME.text,
  secondary: REFERENCE_THEME.textSecondary,
  tertiary: REFERENCE_THEME.textTertiary,
  accent: REFERENCE_THEME.accent,
  accentText: '#07130A',
  overlay: 'rgba(0,0,0,0.70)',
  danger: REFERENCE_THEME.danger,
};

export function ShareRepositorySheet({
  isVisible,
  onClose,
  onShared,
  repositoryId,
  repositoryDetails,
}: ShareRepositorySheetProps) {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const sheetMaxHeight = Math.min(610, height * 0.82);
  const [translateY] = useState(() => new Animated.Value(height));
  const [overlayOpacity] = useState(() => new Animated.Value(0));
  const [toast, setToast] = useState('');
  const [showQr, setShowQr] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useModalScrollLock(isVisible);

  const repositoryQuery = useQuery({
    queryKey: ['repository-share-details', repositoryId],
    queryFn: ({ signal }) => getRepositoryShareDetails(repositoryId, signal),
    enabled: isVisible && Boolean(repositoryId) && !repositoryDetails,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: 1,
    retryDelay: 500,
  });

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
      setShowQr(false);
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

  const details = repositoryDetails ?? repositoryQuery.data;
  const shareUnavailable = !details;
  const linkLoading = !details && (repositoryQuery.isLoading || repositoryQuery.isFetching);
  const linkFailed = !details && repositoryQuery.isError;
  const shareText = details ? `Take a look at ${details.fullName}: ${details.githubUrl}` : '';

  const copyLink = useCallback(async (message = 'Repository link copied') => {
    if (!details) return;
    await Clipboard.setStringAsync(details.githubUrl);
    await haptic('success');
    showToast(message);
  }, [details, haptic, showToast]);

  const openUrl = useCallback(async (url: string) => {
    await haptic();
    await Linking.openURL(url);
    onShared?.();
  }, [haptic, onShared]);

  const openClipboardDestination = useCallback(async (url: string, destination: string) => {
    await copyLink(`Link copied — paste it in ${destination}`);
    await Linking.openURL(url);
    onShared?.();
  }, [copyLink, onShared]);

  const handleAction = useCallback(async (id: ShareActionId) => {
    if (!details) return;
    const encodedUrl = encodeURIComponent(details.githubUrl);
    const encodedText = encodeURIComponent(`Take a look at ${details.fullName}`);
    switch (id) {
      case 'copy': await copyLink(); onShared?.(); break;
      case 'system':
        await haptic();
        await Share.share({ title: details.fullName, message: shareText, url: details.githubUrl });
        onShared?.();
        break;
      case 'whatsapp': await openUrl(`https://wa.me/?text=${encodeURIComponent(shareText)}`); break;
      case 'telegram': await openUrl(`https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`); break;
      case 'discord': await openClipboardDestination('https://discord.com/channels/@me', 'Discord'); break;
      case 'slack': await openClipboardDestination('https://slack.com/app_redirect', 'Slack'); break;
      case 'x': await openUrl(`https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedText}`); break;
      case 'linkedin': await openUrl(`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`); break;
      case 'email': await openUrl(`mailto:?subject=${encodeURIComponent(details.fullName)}&body=${encodeURIComponent(shareText)}`); break;
      case 'qr': await haptic(); setShowQr((current) => !current); break;
    }
  }, [copyLink, details, haptic, onShared, openClipboardDestination, openUrl, shareText]);

  if (!isVisible) return null;

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
        <Pressable accessibilityLabel="Close share sheet" accessibilityRole="button" onPress={closeAnimated} style={StyleSheet.absoluteFill}>
          <Animated.View style={[styles.overlay, { backgroundColor: palette.overlay, opacity: overlayOpacity }]}>
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
                <Text style={[styles.title, { color: palette.text }]}>Share repository</Text>
              </View>
              <Pressable accessibilityLabel="Close" accessibilityRole="button" hitSlop={8} onPress={closeAnimated} style={[styles.closeButton, { backgroundColor: palette.elevated }]}>
                <X color={palette.secondary} size={18} />
              </Pressable>
            </View>

            <View style={styles.actions}>
                  <View accessibilityLiveRegion="polite" style={[styles.linkCard, { backgroundColor: palette.elevatedMuted, borderColor: palette.border }]}>
                    <View style={styles.linkCopy}>
                      <Text numberOfLines={1} selectable style={[styles.linkName, { color: palette.text }]}>{details?.fullName ?? 'GitHub repository link'}</Text>
                      <Text numberOfLines={1} selectable style={[styles.linkUrl, { color: palette.secondary }]}>
                        {details?.githubUrl ?? (linkLoading ? 'Loading repository link…' : 'Repository link unavailable')}
                      </Text>
                    </View>
                    {linkLoading ? (
                      <View accessibilityLabel="Loading repository link" style={styles.linkStatusAction}>
                        <ActivityIndicator color={palette.accent} size="small" />
                      </View>
                    ) : linkFailed ? (
                      <Pressable
                        accessibilityLabel="Retry loading repository link"
                        accessibilityRole="button"
                        onPress={() => repositoryQuery.refetch()}
                        style={({ pressed }) => [styles.linkStatusAction, { borderColor: palette.border }, pressed && styles.pressed]}
                      >
                        <RotateCcw color={palette.accent} size={17} />
                      </Pressable>
                    ) : (
                      <Pressable
                        accessibilityLabel="Copy GitHub repository link"
                        accessibilityRole="button"
                        accessibilityState={{ disabled: shareUnavailable }}
                        disabled={shareUnavailable}
                        onPress={() => void handleAction('copy').catch((error) => {
                          showToast(error instanceof Error ? error.message : 'Unable to copy repository link.');
                        })}
                        style={({ pressed }) => [styles.copyButton, { backgroundColor: palette.accent }, shareUnavailable && styles.disabled, pressed && styles.pressed]}
                      >
                        <Copy color={palette.accentText} size={17} strokeWidth={2.2} />
                        <Text style={[styles.copyButtonText, { color: palette.accentText }]}>Copy</Text>
                      </Pressable>
                    )}
                  </View>

                <ScrollView
                  accessibilityLabel="Repository sharing apps"
                  alwaysBounceHorizontal={false}
                  bounces={false}
                  contentContainerStyle={styles.appRail}
                  decelerationRate="fast"
                  horizontal
                  nestedScrollEnabled
                  showsHorizontalScrollIndicator={false}
                  style={styles.appScroller}
                >
                  {APP_ACTIONS.map(({ id, icon: Icon, label, shortLabel }) => {
                    const visibleLabel = id === 'qr' && showQr ? 'Hide QR code' : label;
                    const visibleShortLabel = id === 'qr' && showQr ? 'Hide QR' : shortLabel;
                    return (
                    <Pressable
                      accessibilityLabel={visibleLabel}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: shareUnavailable }}
                      disabled={shareUnavailable}
                      key={id}
                      onPress={() => void handleAction(id).catch((error) => {
                        showToast(error instanceof Error ? error.message : 'Unable to open share destination.');
                      })}
                      style={({ pressed }) => [
                        styles.appAction,
                        { backgroundColor: palette.elevatedMuted, borderColor: palette.border },
                        shareUnavailable && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View style={[styles.appIcon, { backgroundColor: `${palette.accent}18` }]}>
                        <Icon color={palette.accent} size={20} strokeWidth={1.9} />
                      </View>
                      <Text numberOfLines={1} style={[styles.appActionLabel, { color: palette.secondary }]}>
                        {visibleShortLabel}
                      </Text>
                    </Pressable>
                  )})}
                </ScrollView>
            </View>

            {toast ? (
              <View accessibilityLiveRegion="polite" style={[styles.toast, { backgroundColor: palette.elevated, borderColor: palette.border }]}>
                <Check color={palette.accent} size={17} strokeWidth={2.4} />
                <Text style={[styles.toastText, { color: palette.text }]}>{toast}</Text>
              </View>
            ) : null}

            {showQr && details ? (
              <View accessibilityViewIsModal style={styles.qrOverlay}>
                <Pressable accessibilityLabel="Hide QR code" accessibilityRole="button" onPress={() => setShowQr(false)} style={[StyleSheet.absoluteFill, styles.qrDim]} />
                <View style={[styles.qrCard, { backgroundColor: '#FFFFFF', borderColor: palette.border }]}>
                  <QRCode backgroundColor="#FFFFFF" color="#111711" quietZone={8} size={Math.min(154, width - 120)} value={details.githubUrl} />
                  <Text style={styles.qrLabel}>Scan to open repository</Text>
                </View>
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
  header: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerText: { flex: 1 },
  title: { fontFamily: 'NataSans-Bold', fontSize: 19, lineHeight: 24 },
  closeButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  actions: { paddingHorizontal: 14, paddingBottom: 16, gap: 12 },
  linkCard: { minHeight: 62, borderWidth: 1, borderRadius: 16, padding: 10, paddingLeft: 13, flexDirection: 'row', alignItems: 'center', gap: 10 },
  linkCopy: { flex: 1, minWidth: 0, gap: 2 },
  linkName: { fontFamily: 'NataSans-SemiBold', fontSize: 13.5, lineHeight: 18 },
  linkUrl: { fontFamily: 'NataSans-Regular', fontSize: 10.5, lineHeight: 15 },
  copyButton: { minHeight: 38, borderRadius: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  copyButtonText: { fontFamily: 'NataSans-Bold', fontSize: 12.5 },
  linkStatusAction: { width: 38, height: 38, borderWidth: 1, borderColor: 'transparent', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  appScroller: { marginHorizontal: -14 },
  appRail: { paddingHorizontal: 14, paddingVertical: 2, gap: 8 },
  appAction: { width: 78, minHeight: 72, borderWidth: 1, borderRadius: 14, paddingHorizontal: 5, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', gap: 6 },
  appIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  appActionLabel: { maxWidth: '100%', fontFamily: 'NataSans-Medium', fontSize: 9.5, lineHeight: 12, textAlign: 'center' },
  pressed: { opacity: 0.72, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.45 },
  qrOverlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, zIndex: 20, alignItems: 'center', justifyContent: 'center', padding: 18 },
  qrDim: { backgroundColor: 'rgba(4,6,4,0.82)' },
  qrCard: { borderWidth: 1, borderRadius: 18, padding: 14, alignItems: 'center', gap: 8, boxShadow: '0 18px 50px rgba(0,0,0,0.55)' },
  qrLabel: { color: '#3E463E', fontFamily: 'NataSans-SemiBold', fontSize: 11.5 },
  toast: { position: 'absolute', left: 14, right: 14, bottom: 14, minHeight: 44, borderWidth: 1, borderRadius: 13, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  toastText: { fontFamily: 'NataSans-SemiBold', fontSize: 12 },
});
