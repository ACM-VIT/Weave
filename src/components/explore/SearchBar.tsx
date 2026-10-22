import React, { useRef } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onCompositionChange?: (composing: boolean) => void;
}

function SearchGlyph(): React.JSX.Element {
  return (
    <Svg width={15} height={15} viewBox="0 0 24 24" fill="none">
      <Circle cx={11} cy={11} r={7} stroke="rgba(235,235,245,0.4)" strokeWidth={2} />
      <Path d="m20 20-3.5-3.5" stroke="rgba(235,235,245,0.4)" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

export default function SearchBar({
  value,
  onChangeText,
  placeholder = 'Search repositories, people and Lists',
  onCompositionChange,
}: SearchBarProps): React.JSX.Element {
  const input = useRef<TextInput>(null);
  return (
    <View style={{ paddingTop: 14, paddingHorizontal: 20 }}>
      <View
        style={{
          minHeight: 48,
          borderRadius: 12,
          backgroundColor: 'rgba(118, 118, 128, 0.18)',
          paddingHorizontal: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <SearchGlyph />
        <TextInput
          ref={input}
          accessibilityLabel="Search repositories, people and Lists"
          maxLength={512}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          {...(Platform.OS === 'web' ? {
            onCompositionStart: () => onCompositionChange?.(true),
            onCompositionEnd: () => onCompositionChange?.(false),
          } : {})}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor="#A6A6AE"
          style={{
            flex: 1,
            color: '#FFFFFF',
            fontSize: 15,
            minHeight: 48,
            padding: 0,
            borderWidth: 0,
          }}
        />
        {value ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => { onCompositionChange?.(false); onChangeText(''); input.current?.focus(); }} style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#FFFFFF', fontSize: 22 }}>×</Text>
        </Pressable> : null}
      </View>
    </View>
  );
}
