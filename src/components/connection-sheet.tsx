import { useReducedMotion } from 'react-native-reanimated';
import { KeyboardSurface } from '@/components/keyboard/keyboard-layout';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ConnectionType } from '@/api/connections';
import { REFERENCE_THEME } from '@/constants/theme';
import { ConnectionList } from './connection-list';
import {
  ProfileRepositoryList,
  type ProfileRepositoryType,
} from './profile-repository-list';

export type { ConnectionType };
export type ProfileStatType = ConnectionType | ProfileRepositoryType;

export type ConnectionSheetProps = {
  visible: boolean;
  type: ProfileStatType;
  username?: string;
  userId?: string;
  onClose: () => void;
  onFollowingCountChange?: (delta: 1 | -1) => void;
};

const OPEN_DURATION = 280;
const CLOSE_DURATION = 220;
const OVERLAY_DURATION = 200;
const SHEET_EASING = Easing.bezier(0.32, 0.72, 0, 1);

export function ConnectionSheet({
  visible,
  type,
  username,
  userId,
  onClose,
  onFollowingCountChange,
}: ConnectionSheetProps) {
  const { height, width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const sheetHeight = Math.min(Math.floor(height * 0.82), 720);
  const overlayOpacity = useMemo(() => new Animated.Value(0), []);
  const sheetTranslateY = useMemo(
    () => new Animated.Value(sheetHeight),
    [sheetHeight],
  );
  const closingRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    closingRef.current = false;
    overlayOpacity.setValue(0);
    sheetTranslateY.setValue(sheetHeight);

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
  }, [overlayOpacity, sheetHeight, sheetTranslateY, visible, reducedMotion]);

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
        toValue: sheetHeight,
        duration: reducedMotion ? 0 : CLOSE_DURATION,
        easing: SHEET_EASING,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      closingRef.current = false;
      if (finished) onClose();
    });
  }, [onClose, overlayOpacity, sheetHeight, sheetTranslateY, reducedMotion]);

  const title = type === 'followers'
    ? 'Followers'
    : type === 'following'
      ? 'Following'
      : type === 'likes'
        ? 'Likes Given'
        : 'Saved';
  const normalizedUsername = username?.replace(/^@/, '');

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={closeAnimated}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={styles.modalRoot}>
        <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
          <BlurView intensity={13} tint="dark" style={StyleSheet.absoluteFill} />
          <Pressable
            accessibilityLabel={`Close ${title.toLocaleLowerCase()}`}
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
                width: Math.min(width, 560),
                height: sheetHeight,
                transform: [{ translateY: sheetTranslateY }],
              },
            ]}
          >
            <View style={styles.grabberWrap}>
              <View style={styles.grabber} />
            </View>

            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text style={styles.title}>{title}</Text>
                {normalizedUsername ? (
                  <Text numberOfLines={1} selectable style={styles.subtitle}>
                    @{normalizedUsername}
                  </Text>
                ) : null}
              </View>
              <Pressable
                accessibilityLabel={`Close ${title.toLocaleLowerCase()}`}
                accessibilityRole="button"
                hitSlop={14}
                onPress={closeAnimated}
                style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
              >
                <X color={REFERENCE_THEME.textSecondary} size={14} strokeWidth={2.6} />
              </Pressable>
            </View>

            {type === 'followers' || type === 'following' ? (
              <ConnectionList
                active={visible}
                contentPaddingBottom={Math.max(insets.bottom, 20)}
                onFollowingCountChange={onFollowingCountChange}
                type={type}
                userId={userId}
                username={username}
              />
            ) : (
              <ProfileRepositoryList
                active={visible}
                contentPaddingBottom={Math.max(insets.bottom, 20)}
                type={type}
                userId={userId}
              />
            )}
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
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  keyboardRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxWidth: 560,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: '#111113',
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderColor: REFERENCE_THEME.border,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -12 },
    shadowOpacity: 0.55,
    shadowRadius: 40,
    elevation: 24,
  },
  grabberWrap: {
    height: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grabber: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(235,235,245,0.28)',
  },
  header: {
    minHeight: 58,
    paddingHorizontal: 18,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: REFERENCE_THEME.separator,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 21,
    lineHeight: 26,
    letterSpacing: -0.35,
  },
  subtitle: {
    marginTop: 1,
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-Regular',
    fontSize: 12,
    lineHeight: 16,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 15,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: REFERENCE_THEME.controlStrong,
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.95 }],
  },
});
