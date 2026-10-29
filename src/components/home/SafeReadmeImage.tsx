import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Image, type ImageLoadEventData } from 'expo-image';
import type { CustomBlockRenderer } from 'react-native-render-html';
import { useContentWidth } from 'react-native-render-html';

import { normalizeGithubReadmeImageUrl } from '@/utils/readme-images';
import { REFERENCE_THEME } from '@/constants/theme';

const MAX_IMAGE_HEIGHT = 360;
const DEFAULT_ASPECT_RATIO = 16 / 9;

type SafeReadmeImageProps = {alt:string;compact?:boolean;maximumWidth:number;url:string;priority?:'low'|'normal'|'high';loading?:'lazy'|'eager'};

export function SafeReadmeImage(props: SafeReadmeImageProps) {
  const url=normalizeGithubReadmeImageUrl(props.url);
  return <ReadmeImageSource key={url} {...props} url={url}/>;
}

function ReadmeImageSource({
  alt,
  compact = false,
  maximumWidth,
  url,
  priority = 'high',
  loading: loadingPolicy = 'lazy',
}: SafeReadmeImageProps) {
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_ASPECT_RATIO);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const boundedWidth = Math.max(1, maximumWidth);
  const maximumHeight = compact ? 96 : MAX_IMAGE_HEIGHT;
  const height = Math.min(maximumHeight, Math.max(compact ? 64 : 120, boundedWidth / aspectRatio));

  if (failed) {
    return (
      <View accessibilityRole="text" style={[styles.fallback, { width: boundedWidth }]}>
        <Text style={styles.fallbackText}>
          {alt ? `Image unavailable: ${alt}` : 'README image unavailable'}
        </Text>
      </View>
    );
  }

  const handleLoad = (event: ImageLoadEventData) => {
    const { width, height: sourceHeight } = event.source;
    if (width > 0 && sourceHeight > 0) setAspectRatio(width / sourceHeight);
    setLoading(false);
  };

  return (
    <View
      accessible
      accessibilityLabel={alt || 'README image'}
      accessibilityRole="image"
      style={[styles.container, compact && styles.containerCompact, { height, width: boundedWidth }]}
    >
      <Image
        cachePolicy="memory-disk"
        priority={priority}
        loading={loadingPolicy}
        contentFit="contain"
        onError={() => {
          setFailed(true);
          setLoading(false);
        }}
        onLoad={handleLoad}
        recyclingKey={url}
        source={{ uri: url }}
        style={StyleSheet.absoluteFill}
        transition={150}
      />
      {loading ? (
        <View pointerEvents="none" style={styles.loading}>
          <ActivityIndicator color={REFERENCE_THEME.accentLight} size="small" />
        </View>
      ) : null}
    </View>
  );
}

export const SafeReadmeImageRenderer: CustomBlockRenderer = ({ tnode }) => {
  const contentWidth = useContentWidth();
  const source = tnode.attributes.src ?? '';
  if (!source) return null;

  return (
    <SafeReadmeImage
      alt={tnode.attributes.alt ?? ''}
      key={source}
      maximumWidth={contentWidth}
      url={source}
    />
  );
};

const styles = StyleSheet.create({
  container: {
    alignSelf: 'center',
    marginVertical: 10,
    overflow: 'hidden',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.035)',
  },
  containerCompact: {
    marginTop: 2,
    marginBottom: 8,
    borderRadius: 8,
  },
  loading: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,24,21,0.78)',
  },
  fallback: {
    minHeight: 54,
    alignSelf: 'center',
    justifyContent: 'center',
    marginVertical: 10,
    padding: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  fallbackText: {
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-Regular',
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
});
