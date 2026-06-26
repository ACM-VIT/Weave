import React from 'react';
import { Text, View } from 'react-native';

interface AvatarProps {
  color: string;
  initial: string;
  size?: number;
  author?: string;
}

export default function Avatar({ color, initial, size = 18, author }: AvatarProps): React.JSX.Element {
  if (author === 'codebyalex') {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: size * 0.95, lineHeight: size * 1.15 }}>🇺🇸</Text>
      </View>
    );
  } else if (author === 'appstudio') {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: size * 0.95, lineHeight: size * 1.15 }}>🌍</Text>
      </View>
    );

  } else if (author === 'backendninja') {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: size * 0.95, lineHeight: size * 1.15 }}>🌐</Text>
      </View>
    );
  }

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#fff', fontSize: size * 0.5, fontFamily: 'NataSans-Bold' }}>
        {initial}
      </Text>
    </View>
  );
}
