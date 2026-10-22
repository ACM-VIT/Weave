import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { recommendationReason, type RecommendationSource } from '../../models/recommendation';
import { REFERENCE_THEME } from '../../constants/theme';

export function RecommendationReason({ source }: { source?: RecommendationSource }) {
  if (!source) return null;
  const reason = recommendationReason(source);
  return <Text accessibilityLabel={`Why you're seeing this: ${reason}`}
    numberOfLines={2} style={styles.reason} testID="recommendation-reason">{reason}</Text>;
}

const styles = StyleSheet.create({
  reason: { color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 11, lineHeight: 15 },
});
