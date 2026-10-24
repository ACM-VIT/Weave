import React from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { recommendationReason, type RecommendationSource } from '../../models/recommendation';
import { parseRepositoryLabel, type RepositoryLabel } from '../../models/repository-label';
import { REFERENCE_THEME } from '../../constants/theme';
import { repositoryLabelPresentation } from './repository-label-presentation';

export function RecommendationReason({ source, label }: {
  source?: RecommendationSource;
  label?: RepositoryLabel | null;
}) {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    if (!label) return;
    let timer: ReturnType<typeof setTimeout>;
    const refreshClock = () => {
      const time = Date.now();
      setNow(time);
      const remaining = Date.parse(label.expires_at) - time;
      if (remaining > 0) timer = setTimeout(refreshClock, Math.min(remaining + 1, 2_147_483_647));
    };
    timer = setTimeout(refreshClock, 0);
    return () => clearTimeout(timer);
  }, [label]);
  React.useEffect(() => {
    if (!label) return;
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') setNow(Date.now());
    });
    return () => listener.remove();
  }, [label]);
  const currentLabel = parseRepositoryLabel(label, now);
  if (currentLabel) {
    const presentation = repositoryLabelPresentation(currentLabel);
    const Icon = presentation.icon;
    return <View accessible accessibilityRole="text" accessibilityLabel={presentation.accessibilityLabel}
      style={[styles.badge, presentation.tone]} testID="repository-label">
      <Icon size={14} color={presentation.tone.color} strokeWidth={1.8} accessible={false} />
      <Text style={[styles.badgeText, { color: presentation.tone.color }]}>{presentation.text}</Text>
    </View>;
  }
  if (!source) return null;
  const reason = recommendationReason(source);
  return <Text accessibilityLabel={`Why you're seeing this: ${reason}`}
    numberOfLines={2} style={styles.reason} testID="recommendation-reason">{reason}</Text>;
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start', maxWidth: '100%', flexDirection: 'row', alignItems: 'center',
    gap: 6, paddingHorizontal: 11, paddingVertical: 6, minHeight: 30,
    marginTop: 3, marginBottom: 2, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8,
  },
  badgeText: {
    flexShrink: 1, fontFamily: 'NataSans-Medium', fontSize: 11, lineHeight: 16,
  },
  reason: { color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 11, lineHeight: 15 },
});
