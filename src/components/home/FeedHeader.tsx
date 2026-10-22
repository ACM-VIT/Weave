import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { RefreshCw } from 'lucide-react-native';

import { REFERENCE_THEME } from '@/constants/theme';

const WEAVE_LOGO = require('../../../assets/images/logo/weavelogo.png');

export function FeedHeader({ pageWidth, discovery = false, onRefresh, refreshing = false }: { pageWidth: number; discovery?: boolean; onRefresh?: () => void; refreshing?: boolean }) {
  const insets = useSafeAreaInsets();
  const compact = pageWidth < 360;
  const outerGutter = pageWidth < 330 ? 10 : 14;
  const logoSize = compact ? 26 : 30;
  const imageSize = logoSize * 1.4;

  return (
    <View pointerEvents="box-none" style={styles.root}>
      <Svg pointerEvents="none" style={styles.fade} width={pageWidth} height={150}>
        <Defs>
          <LinearGradient id="fixedTopFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0.35" stopColor="#000000" stopOpacity="0.88" />
            <Stop offset="1" stopColor="#000000" stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect width={pageWidth} height="150" fill="url(#fixedTopFade)" />
      </Svg>

      <View
        pointerEvents="box-none"
        style={[
          styles.topBar,
          {
            left: outerGutter,
            right: outerGutter,
            paddingTop: Math.max(insets.top + 6, 40),
          },
        ]}
      >
        <View style={styles.brandRow}>
          <View
            style={[
              styles.logoFrame,
              { width: logoSize, height: logoSize, borderRadius: logoSize / 2 },
            ]}
          >
            <Image
              accessible={false}
              resizeMode="contain"
              source={WEAVE_LOGO}
              style={{
                position: 'absolute',
                width: imageSize,
                height: imageSize,
                left: (logoSize - imageSize) / 2,
                top: -logoSize * 0.06,
              }}
            />
          </View>
          <Text style={[styles.brand, compact && styles.brandCompact]}>
            Wea<Text style={styles.brandAccent}>v</Text>e
          </Text>
        </View>
        {discovery ? <Text accessibilityLabel="Recently updated repositories. Not personalized recommendations."
          style={styles.sourceLabel}>Recently updated{'\n'}Not personalized</Text> : null}
        {onRefresh && <Pressable accessibilityRole="button" accessibilityLabel="Refresh recommendations"
          disabled={refreshing} onPress={onRefresh} style={styles.refresh}>
          {refreshing ? <ActivityIndicator color={REFERENCE_THEME.accent} /> : <RefreshCw size={22} color={REFERENCE_THEME.text} />}
        </Pressable>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: 7,
  },
  fade: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    position: 'absolute',
    top: 0,
  },
  refresh: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  logoFrame: {
    overflow: 'hidden',
  },
  brand: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
  },
  brandCompact: {
    fontSize: 26,
    lineHeight: 32,
  },
  sourceLabel: {
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-Regular',
    fontSize: 11,
    lineHeight: 15,
    flexShrink: 1,
    textAlign: 'right',
  },
  brandAccent: {
    color: '#63E08A',
  },
});
