import { useRepositoryReadmeSummary } from '@/hooks/use-repository-readme-summary';
import type { ReadmeDigest } from '@/models/readme-digest';
import React, { useMemo } from 'react';
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
  readmeMediaManifest?: { poster: { alt: string; url: string } | null } | null;
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
  onOpenReadme?: () => void;
  compact?: boolean;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function ReadmeCard({
  repository,
  availableWidth,
  isActive = true,
  onReadFullPress,
  onOpenReadme,
  compact = false,
}: ReadmeCardProps) {
  const reduceMotion = useReducedMotion();
  const summaryQuery = useRepositoryReadmeSummary(repository, isActive);
  const readMoreScale = useMemo(() => new Animated.Value(1), []);
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
    : summaryQuery.data?.status==='failed' ? 'README summary unavailable.'
    : summaryQuery.data?.status==='pending' || summaryQuery.data?.status==='processing' ? 'Preparing README summary…'
      : summaryQuery.isLoading ? 'Loading README summary…' : preview.markdown;
  const previewImage = useMemo(
    () => extractReadmePreviewImage(repository.readmeFull, {
      fullName: repository.fullName,
      githubUrl: repository.githubUrl,
      readmeBaseUrl: repository.readmeBaseUrl,
      readmeDefaultBranch: repository.readmeDefaultBranch,
      readmeSourcePath: repository.readmeSourcePath,
    }) ?? repository.readmeMediaManifest?.poster ?? null,
    [
      repository.fullName,
      repository.githubUrl,
      repository.readmeBaseUrl,
      repository.readmeDefaultBranch,
      repository.readmeFull,
      repository.readmeMediaManifest,
      repository.readmeSourcePath,
    ],
  );
  const showPreviewImage = preview.source === 'summary' && !compact && availableWidth >= 320 && Boolean(previewImage);
  const previewImageWidth = Math.min(112, Math.max(88, availableWidth * 0.3));
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
    <View style={[styles.card, compact && styles.cardCompact]}>
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
          <View style={styles.summaryRow}>
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
              {preview.source === 'summary' ? preview.markdown : statusText}
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
          </View>
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
        {preview.source === 'pending' && onOpenReadme ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`Open README for ${repository.name}`}
            accessibilityHint="Opens the original README in a scrollable viewer"
            onPress={onOpenReadme} style={[styles.readFull, styles.readmeAction, compact && styles.readFullCompact]}>
            <Text style={[styles.readFullText, compact && styles.readFullTextCompact]}>Open README</Text>
            <ChevronRight size={compact ? 10 : 11} color={REFERENCE_THEME.accentLight} strokeWidth={2.4} />
          </Pressable>
        ) : null}
      </View>
    </View>
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
  readmeAction: {
    marginTop: 8,
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
