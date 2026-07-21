"use no memo";

import React, { useEffect, useMemo } from 'react';
import {
  Animated,
  Easing,
  Linking,
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
import RenderHtml, { defaultSystemFonts } from 'react-native-render-html';
import { marked } from 'marked';

import { REFERENCE_THEME } from '@/constants/theme';
import { prepareReadmeForDisplay } from '@/utils/readme';

interface ReadmePopupProps {
  isVisible: boolean;
  onClose: () => void;
  title: string;
  readmeText: string;
}

const markdownFonts = [
  ...defaultSystemFonts,
  'NataSans-Regular',
  'NataSans-SemiBold',
  'NataSans-Bold',
];

const markdownTagStyles = {
  body: {
    color: REFERENCE_THEME.textPrimary,
    fontFamily: 'NataSans-Regular',
    fontSize: 14,
    lineHeight: 22,
  },
  h1: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 26,
    lineHeight: 34,
    marginTop: 18,
    marginBottom: 12,
  },
  h2: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 21,
    lineHeight: 29,
    marginTop: 18,
    marginBottom: 10,
  },
  h3: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 17,
    lineHeight: 25,
    marginTop: 16,
    marginBottom: 8,
  },
  h4: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 15,
    lineHeight: 23,
    marginTop: 14,
    marginBottom: 7,
  },
  p: {
    marginTop: 0,
    marginBottom: 12,
  },
  a: {
    color: REFERENCE_THEME.accentLight,
    textDecorationLine: 'underline' as const,
  },
  strong: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
  },
  em: {
    fontStyle: 'italic' as const,
  },
  blockquote: {
    marginVertical: 10,
    marginHorizontal: 0,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderLeftWidth: 3,
    borderLeftColor: REFERENCE_THEME.accent,
    backgroundColor: 'rgba(255,255,255,0.035)',
    color: REFERENCE_THEME.textSecondary,
  },
  code: {
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 2,
    backgroundColor: 'rgba(255,255,255,0.09)',
    color: '#F0F0F5',
    fontFamily: 'monospace',
    fontSize: 13,
  },
  pre: {
    marginVertical: 10,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#111114',
    color: '#F0F0F5',
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 20,
  },
  ul: {
    marginTop: 0,
    marginBottom: 12,
    paddingLeft: 8,
  },
  ol: {
    marginTop: 0,
    marginBottom: 12,
    paddingLeft: 8,
  },
  li: {
    marginBottom: 5,
  },
  hr: {
    marginVertical: 18,
    borderColor: REFERENCE_THEME.separator,
  },
  img: {
    marginVertical: 10,
    borderRadius: 8,
  },
} as const;

export function ReadmePopup({ isVisible, onClose, title, readmeText }: ReadmePopupProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const opacity = useMemo(() => new Animated.Value(0), []);
  const content = prepareReadmeForDisplay(readmeText);
  const markdownHtml = useMemo(
    () => marked.parse(content, { async: false, gfm: true }) as string,
    [content],
  );

  useEffect(() => {
    if (!isVisible) return;
    opacity.setValue(0);
    Animated.timing(opacity, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [isVisible, opacity]);

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
            <RenderHtml
              contentWidth={cardWidth - 44}
              defaultTextProps={{ selectable: true }}
              enableExperimentalMarginCollapsing
              ignoredDomTags={['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button']}
              renderersProps={{
                a: {
                  onPress: (_event, href) => {
                    if (/^(https?:|mailto:)/i.test(href)) void Linking.openURL(href);
                  },
                },
              }}
              source={{ html: markdownHtml }}
              systemFonts={markdownFonts}
              tagsStyles={markdownTagStyles}
            />
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
  pressed: {
    opacity: 0.7,
  },
});
