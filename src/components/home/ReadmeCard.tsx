import { useRepositoryReadmeSummary } from '@/hooks/use-repository-readme-summary';
import type { ReadmeDigest } from '@/models/readme-digest';
import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { BookOpen, ChevronRight } from 'lucide-react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { REFERENCE_THEME } from '@/constants/theme';
import { useTypewriterText } from '@/hooks/use-typewriter-text';
import { extractReadmePreviewImage } from '@/utils/readme-images';
import {
  prepareReadmePreview,
  readmePreviewLineCount,
} from '@/utils/readme';
import { SafeReadmeImage } from './SafeReadmeImage';

type RepositoryData = {
  id: string;
  name: string;
  description: string;
  readmeSummary: string | null;
  readmeDigest?: ReadmeDigest | null;
  summarySource?: 'generated' | 'description_fallback' | null;
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
  onReadFullPress: (digest?: ReadmeDigest | null) => void;
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
  const summaryQuery = useRepositoryReadmeSummary(repository, isActive);
  const entranceProgress = useMemo(() => new Animated.Value(0), []);
  const summaryProgress = useMemo(() => new Animated.Value(0), []);
  const skeletonOpacity = useMemo(() => new Animated.Value(1), []);
  const shimmerProgress = useMemo(() => new Animated.Value(0), []);
  const readMoreScale = useMemo(() => new Animated.Value(1), []);
  const hasAnimated = useRef(false);
  const { fontScale } = useWindowDimensions();
  const [previewHeight, setPreviewHeight] = React.useState(0);
  const previewLines = readmePreviewLineCount(previewHeight, compact ? 17 : 21, fontScale);
  const preview = useMemo(
    () => prepareReadmePreview({
      summary: repository.readmeSummary,
      description: repository.description,
      fullReadme: repository.readmeFull,
      digest: summaryQuery.digest,
      summarySource: repository.summarySource,
    }),
    [
      repository.summarySource,
      summaryQuery.digest,
      repository.description,
      repository.readmeFull,
      repository.readmeSummary,
    ],
  );
  const statusText = summaryQuery.isError ? "Couldn’t load the README summary."
    : summaryQuery.data?.status==='pending' || summaryQuery.data?.status==='processing' ? 'Preparing README summary…'
      : summaryQuery.isLoading ? 'Loading README summary…' : preview.markdown;
  const typedSummary = useTypewriterText(preview.source==='summary' ? preview.markdown : statusText, {
    completionKey: `readme:${repository.id}:${preview.source}`,
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
  const showPreviewImage = preview.source === 'summary' && !compact && availableWidth >= 320 && Boolean(previewImage);
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
    <Animated.View style={[
      styles.card,
      compact && styles.cardCompact,
      preview.source === 'pending' && styles.cardUnavailable,
      animatedCardStyle,
    ]}>
      <View style={[styles.header, compact && styles.headerCompact]}>
        <View style={styles.headerLabel}>
          <BookOpen size={12} color={REFERENCE_THEME.accentLight} strokeWidth={2} />
          <Text style={styles.heading}>README SUMMARY</Text>
        </View>
      </View>

      <View style={[
        styles.body,
        compact && styles.bodyCompact,
        preview.source === 'pending' && styles.cardUnavailable,
      ]}>
        <View
          onLayout={(event) => setPreviewHeight(event.nativeEvent.layout.height)}
          style={[
            styles.markdownViewport,
            preview.source === 'pending' && { flex: 0, minHeight: (compact ? 17 : 21) * fontScale * 2 },
          ]}
        >
          <Animated.View
            style={[styles.summaryRow, { opacity: summaryProgress }]}
          >
            <Text
              ellipsizeMode="tail"
              numberOfLines={preview.source === 'pending' ? 2 : previewLines}
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
        {preview.source === 'summary' ? <AnimatedPressable
          accessibilityHint="Opens the complete README summary in a scrollable popup"
          accessibilityLabel={`Read more about ${repository.name}`}
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => onReadFullPress(summaryQuery.digest)}
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
            Read more
          </Text>
          <ChevronRight
            size={compact ? 10 : 11}
            color={REFERENCE_THEME.accentLight}
            strokeWidth={2.4}
          />
        </AnimatedPressable> : summaryQuery.isError || summaryQuery.data?.status==='failed' ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Check README summary again"
            accessibilityHint="Checks whether a summary is available" onPress={() => void summaryQuery.refetch()}
            style={[styles.readFull,compact && styles.readFullCompact]}>
            <Text style={[styles.readFullText,compact && styles.readFullTextCompact]}>Check again</Text>
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minHeight: 0,
    marginTop: 14,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(28,28,30,0.78)',
    overflow: 'hidden',
  },
  cardUnavailable: {
    flex: 0,
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
    flex: 1,
    minHeight: 0,
    paddingTop: 15,
    paddingHorizontal: 18,
    paddingBottom: 17,
    gap: 0,
  },
  bodyCompact: {
    paddingTop: 9,
    paddingHorizontal: 14,
    paddingBottom: 9,
    gap: 0,
  },
  markdownViewport: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
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
    minHeight: 44,
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
    minHeight: 44,
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
