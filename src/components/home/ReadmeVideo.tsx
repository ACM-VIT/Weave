import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Play } from 'lucide-react-native';
import { REFERENCE_THEME } from '@/constants/theme';

/** A preview only: no player or video download until the dedicated viewer opens. */
export function ReadmeVideo({ onPress }: { url: string; onPress: () => void }) {
  return <Pressable cssInterop={false} accessibilityRole="button" accessibilityLabel="Open README video"
    accessibilityHint="Opens a larger video player. Closing it returns to this summary."
    onPress={onPress} style={({ pressed }) => ({ marginVertical: 16, borderRadius: 12,
      overflow: 'hidden', borderWidth: 1, borderColor: REFERENCE_THEME.separator,
      backgroundColor: REFERENCE_THEME.surface, opacity: pressed ? 0.75 : 1 })}>
    <View style={{ aspectRatio: 16 / 9, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <Play color={REFERENCE_THEME.accentLight} size={36} />
      <Text style={{ color: REFERENCE_THEME.textPrimary }}>Watch repository demo</Text>
    </View>
  </Pressable>;
}
