import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { BookOpen, ChevronRight } from 'lucide-react-native';
import { useReducedMotion } from 'react-native-reanimated';
import RenderHtml, {
  defaultSystemFonts,
  type RenderersProps,
} from 'react-native-render-html';
import { marked } from 'marked';

import { REFERENCE_THEME } from '@/constants/theme';
import { useTypewriterText } from '@/hooks/use-typewriter-text';
import {
  prepareReadmePreview,
  README_COMPACT_PREVIEW_MAX_CHARACTERS,
  README_PREVIEW_MAX_CHARACTERS,
} from '@/utils/readme';

type RepositoryData = {
  title: string;
  readmeSummary: string;
  readmeFull: string;
  techStack?: string[];
};

type ReadmeCardProps = {
  repository: RepositoryData;
  availableWidth: number;
  isActive?: boolean;
  onReadFullPress: () => void;
  compact?: boolean;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const markdownFonts = [
  ...defaultSystemFonts,
  'NataSans-Regular',
  'NataSans-SemiBold',
  'NataSans-Bold',
];

const ignoredMarkdownTags = [
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
  'img',
];

const markdownTextProps = { selectable: true } as const;

function openSafeMarkdownLink(_event: GestureResponderEvent, href: string) {
  if (!/^(https?:|mailto:)/i.test(href)) return;
  void Linking.openURL(href).catch(() => undefined);
}

const markdownRenderersProps = {
  a: { onPress: openSafeMarkdownLink },
  ol: {
    markerTextStyle: {
      color: REFERENCE_THEME.accentLight,
      fontFamily: 'NataSans-SemiBold',
    },
  },
  ul: {
    markerTextStyle: {
      color: REFERENCE_THEME.accentLight,
      fontFamily: 'NataSans-SemiBold',
    },
  },
} satisfies Partial<RenderersProps>;

const markdownTagStyles = {
  body: {
    color: REFERENCE_THEME.textStrong,
    fontFamily: 'NataSans-Regular',
    fontSize: 13.5,
    lineHeight: 21,
  },
  p: {
    marginTop: 0,
    marginBottom: 10,
  },
  h1: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 18.5,
    lineHeight: 25,
    marginTop: 4,
    marginBottom: 9,
  },
  h2: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 16.5,
    lineHeight: 23,
    marginTop: 7,
    marginBottom: 8,
  },
  h3: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 6,
    marginBottom: 7,
  },
  h4: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 5,
    marginBottom: 6,
  },
  h5: {
    color: REFERENCE_THEME.textStrong,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 13.5,
    lineHeight: 20,
    marginTop: 4,
    marginBottom: 5,
  },
  h6: {
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 12.5,
    lineHeight: 19,
    marginTop: 4,
    marginBottom: 5,
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
    color: REFERENCE_THEME.textStrong,
    fontStyle: 'italic' as const,
  },
  blockquote: {
    marginTop: 2,
    marginBottom: 10,
    marginHorizontal: 0,
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderLeftWidth: 2,
    borderLeftColor: REFERENCE_THEME.accent,
    borderRadius: 6,
    backgroundColor: 'rgba(48,209,88,0.055)',
    color: REFERENCE_THEME.textSecondary,
  },
  ul: {
    marginTop: 0,
    marginBottom: 10,
    paddingLeft: 8,
  },
  ol: {
    marginTop: 0,
    marginBottom: 10,
    paddingLeft: 8,
  },
  li: {
    marginBottom: 4,
  },
  code: {
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    backgroundColor: 'rgba(135,228,158,0.10)',
    color: '#DDF8E4',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  pre: {
    marginTop: 2,
    marginBottom: 10,
    padding: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(135,228,158,0.18)',
    borderRadius: 9,
    backgroundColor: '#101311',
    color: '#E9F5EC',
    fontFamily: 'monospace',
    fontSize: 11.5,
    lineHeight: 18,
  },
  hr: {
    marginVertical: 12,
    borderColor: REFERENCE_THEME.separator,
  },
} as const;

const compactMarkdownTagStyles = {
  ...markdownTagStyles,
  body: {
    ...markdownTagStyles.body,
    fontSize: 11.5,
    lineHeight: 17,
  },
  p: {
    ...markdownTagStyles.p,
    marginBottom: 6,
  },
  h1: {
    ...markdownTagStyles.h1,
    fontSize: 15,
    lineHeight: 20,
    marginTop: 2,
    marginBottom: 5,
  },
  h2: {
    ...markdownTagStyles.h2,
    fontSize: 14,
    lineHeight: 19,
    marginTop: 3,
    marginBottom: 5,
  },
  h3: {
    ...markdownTagStyles.h3,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
    marginBottom: 4,
  },
  h4: {
    ...markdownTagStyles.h4,
    fontSize: 12.5,
    lineHeight: 18,
    marginTop: 2,
    marginBottom: 4,
  },
  code: {
    ...markdownTagStyles.code,
    fontSize: 10.5,
  },
  pre: {
    ...markdownTagStyles.pre,
    padding: 8,
    fontSize: 10,
    lineHeight: 15,
    marginBottom: 6,
  },
  ul: {
    ...markdownTagStyles.ul,
    marginBottom: 6,
  },
  ol: {
    ...markdownTagStyles.ol,
    marginBottom: 6,
  },
  li: {
    ...markdownTagStyles.li,
    marginBottom: 2,
  },
} as const;

export default function ReadmeCard({
  repository,
  availableWidth,
  isActive = true,
  onReadFullPress,
  compact = false,
}: ReadmeCardProps) {
  const reduceMotion = useReducedMotion();
  const entranceProgress = useMemo(() => new Animated.Value(0), []);
  const summaryProgress = useMemo(() => new Animated.Value(0), []);
  const skeletonOpacity = useMemo(() => new Animated.Value(1), []);
  const shimmerProgress = useMemo(() => new Animated.Value(0), []);
  const readMoreScale = useMemo(() => new Animated.Value(1), []);
  const hasAnimated = useRef(false);
  const previewLimit = compact
    ? README_COMPACT_PREVIEW_MAX_CHARACTERS
    : README_PREVIEW_MAX_CHARACTERS;
  const preview = useMemo(
    () => prepareReadmePreview(
      repository.readmeSummary,
      repository.readmeFull,
      previewLimit,
    ),
    [previewLimit, repository.readmeFull, repository.readmeSummary],
  );
  const typedSummary = useTypewriterText(preview.markdown, {
    delay: 140,
    duration: 900,
    enabled: isActive,
    reducedMotion: reduceMotion,
  });
  const animatedSummary = typedSummary.isTyping
    ? `${typedSummary.text}${typedSummary.cursorVisible ? ' ▍' : '  '}`
    : typedSummary.text;
  const markdownHtml = useMemo(
    () => marked.parse(animatedSummary, { async: false, gfm: true }) as string,
    [animatedSummary],
  );
  const normalizedSummary = repository.readmeSummary.trim();
  const normalizedFullReadme = repository.readmeFull.trim();
  const hasMoreContent = preview.isTruncated || (
    normalizedFullReadme.length > 0 && normalizedFullReadme !== normalizedSummary
  );
  const actionLabel = hasMoreContent ? 'Read more' : 'View README';

  useEffect(() => {
    if (!isActive || hasAnimated.current) return;

    hasAnimated.current = true;
    entranceProgress.stopAnimation();

    if (reduceMotion) {
      entranceProgress.setValue(1);
      summaryProgress.setValue(1);
      skeletonOpacity.setValue(0);
      shimmerProgress.setValue(1);
      return;
    }

    const animation = Animated.parallel([
      Animated.timing(entranceProgress, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(shimmerProgress, {
        toValue: 1,
        duration: 320,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(summaryProgress, {
        toValue: 1,
        delay: 110,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(skeletonOpacity, {
        toValue: 0,
        delay: 110,
        duration: 200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]);
    animation.start();

    return () => {
      animation.stop();
      entranceProgress.setValue(1);
      summaryProgress.setValue(1);
      skeletonOpacity.setValue(0);
      shimmerProgress.setValue(1);
    };
  }, [
    entranceProgress,
    isActive,
    reduceMotion,
    shimmerProgress,
    skeletonOpacity,
    summaryProgress,
  ]);

  const animatedCardStyle = useMemo(() => ({
    opacity: entranceProgress.interpolate({
      inputRange: [0, 1],
      outputRange: [0.78, 1],
    }),
    transform: [
      {
        translateY: entranceProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [10, 0],
        }),
      },
      {
        scale: entranceProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [0.985, 1],
        }),
      },
    ],
  }), [entranceProgress]);

  const animateReadMore = (toValue: number, duration: number) => {
    readMoreScale.stopAnimation();
    if (reduceMotion) {
      readMoreScale.setValue(toValue);
      return;
    }
    Animated.timing(readMoreScale, {
      toValue,
      duration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View style={[styles.card, compact && styles.cardCompact, animatedCardStyle]}>
      <View style={[styles.header, compact && styles.headerCompact]}>
        <View style={styles.headerLabel}>
          <BookOpen size={12} color={REFERENCE_THEME.accentLight} strokeWidth={2} />
          <Text style={styles.heading}>README SUMMARY</Text>
        </View>
      </View>

      <View style={[styles.body, compact && styles.bodyCompact]}>
        <View style={[styles.markdownViewport, compact && styles.markdownViewportCompact]}>
          <Animated.View style={{ opacity: summaryProgress }}>
            <RenderHtml
              contentWidth={Math.max(availableWidth - (compact ? 28 : 36), 1)}
              defaultTextProps={markdownTextProps}
              enableCSSInlineProcessing={false}
              enableExperimentalMarginCollapsing
              ignoredDomTags={ignoredMarkdownTags}
              renderersProps={markdownRenderersProps}
              source={{ html: markdownHtml }}
              systemFonts={markdownFonts}
              tagsStyles={compact ? compactMarkdownTagStyles : markdownTagStyles}
            />
          </Animated.View>
          <Animated.View
            pointerEvents="none"
            style={[styles.skeleton, { opacity: skeletonOpacity }]}
          >
            <View style={[styles.skeletonLine, compact && styles.skeletonLineCompact]} />
            <View style={[styles.skeletonLine, styles.skeletonLineLong, compact && styles.skeletonLineCompact]} />
            <View style={[styles.skeletonLine, styles.skeletonLineMedium, compact && styles.skeletonLineCompact]} />
            {!compact ? <View style={[styles.skeletonLine, styles.skeletonLineShort]} /> : null}
            <Animated.View
              style={[
                styles.shimmer,
                {
                  transform: [{
                    translateX: shimmerProgress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-120, availableWidth],
                    }),
                  }],
                },
              ]}
            />
          </Animated.View>
        </View>
        <AnimatedPressable
          accessibilityHint="Opens the complete README in a scrollable view"
          accessibilityLabel={`${actionLabel} for ${repository.title}`}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onReadFullPress}
          onPressIn={() => animateReadMore(0.97, 120)}
          onPressOut={() => animateReadMore(1, 220)}
          style={[
            styles.readFull,
            compact && styles.readFullCompact,
            {
              opacity: readMoreScale.interpolate({
                inputRange: [0.97, 1],
                outputRange: [0.78, 1],
              }),
              transform: [{ scale: readMoreScale }],
            },
          ]}
        >
          <Text style={[styles.readFullText, compact && styles.readFullTextCompact]}>
            {actionLabel}
          </Text>
          <ChevronRight
            size={compact ? 10 : 11}
            color={REFERENCE_THEME.accentLight}
            strokeWidth={2.4}
          />
        </AnimatedPressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 14,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(28,28,30,0.78)',
    overflow: 'hidden',
  },
  cardCompact: {
    marginTop: 8,
  },
  header: {
    minHeight: 41,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(135,228,158,0.10)',
    backgroundColor: 'rgba(48,209,88,0.035)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  headerCompact: {
    minHeight: 35,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  headerLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  heading: {
    color: REFERENCE_THEME.accentLight,
    fontFamily: 'NataSans-Bold',
    fontSize: 10.5,
    lineHeight: 15,
    letterSpacing: 0.75,
  },
  body: {
    paddingTop: 15,
    paddingHorizontal: 18,
    paddingBottom: 17,
    gap: 11,
  },
  bodyCompact: {
    paddingTop: 9,
    paddingHorizontal: 14,
    paddingBottom: 9,
    gap: 6,
  },
  markdownViewport: {
    minHeight: 150,
    maxHeight: 150,
    overflow: 'hidden',
  },
  markdownViewportCompact: {
    minHeight: 54,
    maxHeight: 88,
  },
  skeleton: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
    gap: 10,
    paddingTop: 4,
    backgroundColor: '#1C1C1E',
  },
  skeletonLine: {
    width: '92%',
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(235,235,245,0.10)',
  },
  skeletonLineCompact: {
    height: 9,
    borderRadius: 4.5,
  },
  skeletonLineLong: {
    width: '100%',
  },
  skeletonLineMedium: {
    width: '82%',
  },
  skeletonLineShort: {
    width: '58%',
  },
  shimmer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 72,
    backgroundColor: 'rgba(255,255,255,0.075)',
  },
  readFull: {
    alignSelf: 'flex-start',
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(135,228,158,0.22)',
    borderRadius: 999,
    backgroundColor: 'rgba(48,209,88,0.09)',
  },
  readFullCompact: {
    minHeight: 32,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  readFullText: {
    color: REFERENCE_THEME.accentLight,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 12,
    lineHeight: 16,
  },
  readFullTextCompact: {
    fontSize: 10.5,
    lineHeight: 14,
  },
});
