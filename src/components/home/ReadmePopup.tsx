"use no memo";

import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { useReducedMotion } from 'react-native-reanimated';
import RenderHtml, {
  defaultSystemFonts,
  type CustomTagRendererRecord,
} from 'react-native-render-html';

import { REFERENCE_THEME } from '@/constants/theme';
import { prepareReadmeForDisplay, README_SUMMARY_PENDING } from '@/utils/readme';
import { openReadmeExternalLink } from '@/utils/readme-external-link';
import {
  renderReadmeMarkdown,
  extractReadmeSummaryImages,
  type ReadmeImageContext,
} from '@/utils/readme-images';
import { extractReadmeVideos } from '@/utils/readme-videos';
import { readmePopupBlocks } from '@/utils/readme-popup-content';
import { ReadmeImagePopup } from './ReadmeImagePopup';
import { ReadmeVideoPopup } from './ReadmeVideoPopup';
import { ReadmeVideo } from './ReadmeVideo';
import { SafeReadmeImage, SafeReadmeImageRenderer } from './SafeReadmeImage';

interface ReadmePopupProps {
  isVisible: boolean;
  onClose: () => void;
  title: string;
  readmeText: string | null;
  mediaMessage?: string | null;
  mediaMarkdown?: string | null;
  contentKind?: 'readme' | 'summary';
  loading?: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
  readmeSource: ReadmeImageContext;
}

const POPUP_OPEN_DURATION = 200;
const CONTENT_REVEAL_DELAY = 35;
const CONTENT_REVEAL_DURATION = 115;
const POPUP_CLOSE_DURATION = 160;

const markdownFonts = [
  ...defaultSystemFonts,
  'NataSans-Regular',
  'NataSans-SemiBold',
  'NataSans-Bold',
];

const markdownRenderers: CustomTagRendererRecord = {
  img: SafeReadmeImageRenderer,
};

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

export function ReadmePopup(props: ReadmePopupProps) {
  return props.isVisible ? <VisibleReadmePopup {...props} /> : null;
}

function VisibleReadmePopup({
  isVisible,
  onClose,
  title,
  readmeText,
  contentKind = 'readme',
  mediaMarkdown,
  mediaMessage,
  readmeSource,
  loading = false,
  errorMessage = null,
  onRetry,
}: ReadmePopupProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const opacity = useMemo(() => new Animated.Value(0), []);
  const contentProgress = useMemo(() => new Animated.Value(0), []);
  const closingRef = useRef(false);
  const [media, setMedia] = useState<{kind:'video';url:string}|{kind:'image';url:string;alt:string}|null>(null);
  const content = useMemo(() => contentKind === 'summary'
    ? readmeText || README_SUMMARY_PENDING
    : prepareReadmeForDisplay(readmeText), [contentKind, readmeText]);
  const videos = useMemo(() => extractReadmeVideos(mediaMarkdown ?? (contentKind === 'readme' ? readmeText : null), readmeSource),
    [mediaMarkdown, contentKind, readmeText, readmeSource]);
  const images = useMemo(() => contentKind === 'summary' ? extractReadmeSummaryImages(mediaMarkdown,readmeSource) : [],
    [contentKind,mediaMarkdown,readmeSource]);
  const markdownHtml = useMemo(
    () => renderReadmeMarkdown(content, readmeSource),
    [content, readmeSource],
  );
  const blocks = useMemo(() => readmePopupBlocks(markdownHtml, videos, contentKind === 'summary',images),
    [markdownHtml, videos, contentKind,images]);
  const cardAnimationStyle = useMemo(() => ({
    opacity,
    transform: [
      {
        translateY: opacity.interpolate({
          inputRange: [0, 1],
          outputRange: [16, 0],
        }),
      },
      {
        scale: opacity.interpolate({
          inputRange: [0, 1],
          outputRange: [0.97, 1],
        }),
      },
    ],
  }), [opacity]);
  const contentAnimationStyle = useMemo(() => ({
    opacity: contentProgress,
    transform: [
      {
        translateY: contentProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [6, 0],
        }),
      },
    ],
  }), [contentProgress]);

  useEffect(() => {
    if (!isVisible) return;

    closingRef.current = false;
    opacity.stopAnimation();
    contentProgress.stopAnimation();
    opacity.setValue(0);
    contentProgress.setValue(0);

    if (reduceMotion) {
      opacity.setValue(1);
      contentProgress.setValue(1);
      return;
    }

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: POPUP_OPEN_DURATION,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.delay(CONTENT_REVEAL_DELAY),
        Animated.timing(contentProgress, {
          toValue: 1,
          duration: CONTENT_REVEAL_DURATION,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    ]).start();

    return () => {
      opacity.stopAnimation();
      contentProgress.stopAnimation();
    };
  }, [contentProgress, isVisible, opacity, reduceMotion]);

  const closeAnimated = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setMedia(null);
    opacity.stopAnimation();
    contentProgress.stopAnimation();

    if (reduceMotion) {
      opacity.setValue(0);
      contentProgress.setValue(0);
      closingRef.current = false;
      onClose();
      return;
    }

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: POPUP_CLOSE_DURATION,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(contentProgress, {
        toValue: 0,
        duration: 80,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      closingRef.current = false;
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
        <Pressable
          accessibilityLabel={contentKind === 'summary' ? 'Close README summary' : 'Close README'}
          accessibilityRole="button"
          onPress={closeAnimated}
          style={StyleSheet.absoluteFill}
        >
          <Animated.View style={[styles.overlay, { opacity }]}>
            <BlurView intensity={12} tint="dark" style={StyleSheet.absoluteFill} />
          </Animated.View>
        </Pressable>

        <Animated.View
          accessibilityViewIsModal
          accessibilityElementsHidden={Boolean(media)}
          importantForAccessibility={media ? "no-hide-descendants" : "auto"}
          style={[
            styles.card,
            {
              width: cardWidth,
              top,
              bottom,
            },
            cardAnimationStyle,
          ]}
        >
          <View style={styles.header}>
            <View style={styles.headerTitle}>
              <BookOpen size={14} color={REFERENCE_THEME.accentLight} strokeWidth={2} />
              <Text style={styles.headerText}>{contentKind === 'summary' ? 'README SUMMARY' : 'README'}</Text>
            </View>
            <Pressable
              accessibilityLabel={contentKind === 'summary' ? 'Close README summary' : 'Close README'}
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
            <Animated.View style={contentAnimationStyle}>
              <Text style={styles.repoTitle}>{title}</Text>
              {loading ? <Text style={styles.repoTitle} accessibilityLiveRegion="polite">Loading README…</Text>
                : errorMessage ? <View>
                  <Text style={styles.repoTitle} accessibilityRole="alert">{errorMessage}</Text>
                  {onRetry ? <Pressable accessibilityRole="button" accessibilityLabel="Retry loading README"
                    onPress={onRetry} style={styles.retryButton}><Text style={styles.headerText}>Retry</Text></Pressable> : null}
                </View> : blocks.map((block, index) => block.kind === 'video'
                  ? <ReadmeVideo key={block.url} url={block.url} onPress={() => setMedia({kind:'video',url:block.url})} />
                  : block.kind === 'image' ? <Pressable key={block.url} accessibilityRole="button"
                      accessibilityLabel={`Enlarge README image: ${block.alt}`}
                      accessibilityHint="Opens a larger image viewer with zoom controls"
                      onPress={() => setMedia({kind:'image',url:block.url,alt:block.alt})}>
                      <SafeReadmeImage alt={block.alt} url={block.url} maximumWidth={cardWidth - 44} />
                    </Pressable>
                  : <RenderHtml key={`section-${index}`}
                contentWidth={cardWidth - 44}
                defaultTextProps={{ selectable: true }}
                enableExperimentalMarginCollapsing
                ignoredDomTags={[
                  'script',
                  'style',
                  'iframe',
                  'object',
                  'embed',
                  'form',
                  'input',
                  'button',
                  'link',
                  'meta',
                  'video',
                  'audio',
                  'source',
                ]}
                renderers={markdownRenderers}
                renderersProps={{
                  a: {
                    onPress: (_event, href) => {
                      openReadmeExternalLink(href);
                    },
                  },
                }}
                source={{ html: block.content }}
                systemFonts={markdownFonts}
                tagsStyles={markdownTagStyles}
              />)}
              {mediaMessage ? <View>
                <Text style={{ color: REFERENCE_THEME.textSecondary }}>{mediaMessage}</Text>
                {onRetry ? <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retryButton}>
                  <Text style={styles.headerText}>Retry loading videos</Text>
                </Pressable> : null}
              </View> : null}
            </Animated.View>
          </ScrollView>
        </Animated.View>
        {media?.kind === 'video' && isVisible ? <ReadmeVideoPopup key={media.url} url={media.url} onClose={() => setMedia(null)} /> : null}
        {media?.kind === 'image' && isVisible ? <ReadmeImagePopup key={media.url} url={media.url} alt={media.alt} onClose={() => setMedia(null)} /> : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  retryButton: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
  },
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
    width: 44,
    height: 44,
    borderRadius: 22,
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
