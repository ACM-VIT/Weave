import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BookOpen, ChevronRight } from 'lucide-react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { REFERENCE_THEME } from '@/constants/theme';
import { useTypewriterText } from '@/hooks/use-typewriter-text';
import { extractReadmePreviewImage } from '@/utils/readme-images';
import {
  prepareReadmePreview,
  README_COMPACT_PREVIEW_MAX_CHARACTERS,
  README_PREVIEW_MAX_CHARACTERS,
} from '@/utils/readme';
import { SafeReadmeImage } from './SafeReadmeImage';

type RepositoryData = {
  name: string;
  description: string;
  readmeSummary: string | null;
  readmeFull: string | null;
  fullName: string;
  githubUrl: string;
  readmeSourcePath: string | null;
  readmeDefaultBranch: string | null;
  readmeBaseUrl: string | null;
};

type ReadmeCardProps = {
  repository: RepositoryData;
  availableWidth: number;
  isActive?: boolean;
  onReadFullPress: () => void;
  compact?: boolean;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

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
    () => prepareReadmePreview({
      summary: repository.readmeSummary,
      description: repository.description,
      fullReadme: repository.readmeFull,
      maximumCharacters: previewLimit,
    }),
    [
      previewLimit,
      repository.description,
      repository.readmeFull,
      repository.readmeSummary,
    ],
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
  const previewImage = useMemo(
    () => extractReadmePreviewImage(repository.readmeFull, {
      fullName: repository.fullName,
      githubUrl: repository.githubUrl,
      readmeBaseUrl: repository.readmeBaseUrl,
      readmeDefaultBranch: repository.readmeDefaultBranch,
      readmeSourcePath: repository.readmeSourcePath,
    }),
    [
      repository.fullName,
      repository.githubUrl,
      repository.readmeBaseUrl,
      repository.readmeDefaultBranch,
      repository.readmeFull,
      repository.readmeSourcePath,
    ],
  );
  const showPreviewImage = !compact && availableWidth >= 320 && Boolean(previewImage);
  const previewImageWidth = Math.min(112, Math.max(88, availableWidth * 0.3));
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
          <Animated.View
            style={[styles.summaryRow, { opacity: summaryProgress }]}
          >
            <Text
              ellipsizeMode="tail"
              numberOfLines={compact ? 6 : 7}
              selectable
              style={[
                styles.summaryText,
                compact && styles.summaryTextCompact,
                showPreviewImage && styles.summaryTextWithImage,
              ]}
            >
              {animatedSummary}
            </Text>
            {showPreviewImage && previewImage ? (
              <SafeReadmeImage
                alt={previewImage.alt}
                compact
                key={previewImage.url}
                maximumWidth={previewImageWidth}
                url={previewImage.url}
              />
            ) : null}
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
          accessibilityLabel={`View README for ${repository.name}`}
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
            View README
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
    maxHeight: 104,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  summaryText: {
    flexShrink: 1,
    color: REFERENCE_THEME.textStrong,
    fontFamily: 'NataSans-Regular',
    fontSize: 13.5,
    lineHeight: 21,
  },
  summaryTextCompact: {
    fontSize: 11.5,
    lineHeight: 17,
  },
  summaryTextWithImage: {
    flex: 1,
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
