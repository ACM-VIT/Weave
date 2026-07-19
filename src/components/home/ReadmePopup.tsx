"use no memo";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { BookOpen, X } from 'lucide-react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { REFERENCE_THEME } from '@/constants/theme';
import { prepareReadmeForDisplay } from '@/utils/readme';

interface ReadmePopupProps {
  isVisible: boolean;
  onClose: () => void;
  title: string;
  readmeText: string;
}

const POPUP_TYPING_STEP = 12;
const POPUP_TYPING_INTERVAL_MS = 12;

export function ReadmePopup({ isVisible, onClose, title, readmeText }: ReadmePopupProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const opacity = useMemo(() => new Animated.Value(0), []);
  const cursorOpacity = useMemo(() => new Animated.Value(1), []);
  const [typed, setTyped] = useState(0);
  const content = prepareReadmeForDisplay(readmeText);

  useEffect(() => {
    if (!isVisible) return;
    opacity.setValue(0);
    const resetTimer = setTimeout(() => setTyped(0), 0);
    Animated.timing(opacity, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    const typingTimer = setInterval(() => {
      setTyped((current) => {
        const typingStep = Math.max(POPUP_TYPING_STEP, Math.ceil(content.length / 250));
        const next = Math.min(content.length, current + typingStep);
        if (next >= content.length) clearInterval(typingTimer);
        return next;
      });
    }, POPUP_TYPING_INTERVAL_MS);

    return () => {
      clearTimeout(resetTimer);
      clearInterval(typingTimer);
    };
  }, [content, isVisible, opacity]);

  useEffect(() => {
    const cursorAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(cursorOpacity, {
          toValue: 0,
          duration: 1,
          delay: 449,
          useNativeDriver: true,
        }),
        Animated.timing(cursorOpacity, {
          toValue: 1,
          duration: 1,
          delay: 449,
          useNativeDriver: true,
        }),
      ])
    );
    cursorAnimation.start();
    return () => cursorAnimation.stop();
  }, [cursorOpacity]);

  const closeAnimated = () => {
    Animated.timing(opacity, {
      toValue: 0,
      duration: 180,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) onClose();
    });
  };

  const compact = height < 700;
  const top = compact ? Math.max(insets.top + 10, 44) : Math.max(74, insets.top + 20);
  const bottom = compact ? Math.max(insets.bottom + 72, 84) : Math.max(100, insets.bottom + 66);
  const cardWidth = Math.min(width - 32, 488);

  return (
    <Modal
      animationType="none"
      onRequestClose={closeAnimated}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={isVisible}
    >
      <View style={styles.root}>
        <Pressable accessibilityLabel="Close README" onPress={closeAnimated} style={StyleSheet.absoluteFill}>
          <Animated.View style={[styles.overlay, { opacity }]}>
            <BlurView intensity={12} tint="dark" style={StyleSheet.absoluteFill} />
          </Animated.View>
        </Pressable>

        <Animated.View
          style={[
            styles.card,
            {
              width: cardWidth,
              top,
              bottom,
              opacity,
            },
          ]}
        >
          <View style={styles.header}>
            <View style={styles.headerTitle}>
              <BookOpen size={14} color={REFERENCE_THEME.accentLight} strokeWidth={2} />
              <Text style={styles.headerText}>README Summary</Text>
            </View>
            <Pressable
              accessibilityLabel="Close"
              accessibilityRole="button"
              onPress={closeAnimated}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <X size={12} color="rgba(235,235,245,0.70)" strokeWidth={2.6} />
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.repoTitle}>{title}</Text>
            <Text selectable style={styles.readmeText}>
              {content.slice(0, typed)}
            </Text>
            <Animated.View style={[styles.cursor, { opacity: cursorOpacity }]} />
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
  },
  overlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  card: {
    position: 'absolute',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: REFERENCE_THEME.surface,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.6,
    shadowRadius: 60,
    elevation: 24,
  },
  header: {
    paddingTop: 15,
    paddingHorizontal: 18,
    paddingBottom: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: REFERENCE_THEME.separator,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerTitle: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  headerText: {
    color: REFERENCE_THEME.accentLight,
    fontFamily: 'NataSans-Bold',
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 0.3,
  },
  closeButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: REFERENCE_THEME.controlStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingTop: 18,
    paddingHorizontal: 22,
    paddingBottom: 32,
  },
  repoTitle: {
    marginBottom: 14,
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 24,
    lineHeight: 30,
    letterSpacing: -0.5,
  },
  cursor: {
    width: 6,
    height: 12,
    marginTop: 2,
    marginLeft: 2,
    borderRadius: 1,
    backgroundColor: REFERENCE_THEME.accent,
  },
  pressed: {
    opacity: 0.7,
  },
  readmeText: {
    color: REFERENCE_THEME.textPrimary,
    fontFamily: 'NataSans-Regular',
    fontSize: 14,
    lineHeight: 22,
    letterSpacing: -0.1,
  },
});
