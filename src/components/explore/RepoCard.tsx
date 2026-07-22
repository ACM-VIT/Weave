import React from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { Repo } from '../../types';

interface RepoCardProps {
  repo: Repo;
  onPress?: () => void;
  showMetrics?: boolean;
}

function StarIcon(): React.JSX.Element {
  return (
    <Svg width={11} height={11} viewBox="0 0 24 24" fill="#FFD60A">
      <Path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2Z" />
    </Svg>
  );
}

function ForkIcon(): React.JSX.Element {
  return (
    <Svg width={11} height={11} viewBox="0 0 24 24" fill="none">
      <Circle cx={6} cy={4.5} r={2.3} stroke="rgba(235,235,245,0.55)" strokeWidth={2} />
      <Circle cx={18} cy={4.5} r={2.3} stroke="rgba(235,235,245,0.55)" strokeWidth={2} />
      <Circle cx={12} cy={19.5} r={2.3} stroke="rgba(235,235,245,0.55)" strokeWidth={2} />
      <Path
        d="M6 7v1.5A3.5 3.5 0 0 0 9.5 12h5A3.5 3.5 0 0 0 18 8.5V7M12 12v5"
        stroke="rgba(235,235,245,0.55)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function GradientAvatar({ repo }: { repo: Repo }): React.JSX.Element {
  const colors = repo.avatarGradient ?? [repo.avatarColor, repo.avatarColor];

  return (
    <View style={{ width: 20, height: 20 }}>
      <Svg width={20} height={20} viewBox="0 0 20 20">
        <Defs>
          <LinearGradient id={`avatar-${repo.id}`} x1="3" y1="2" x2="17" y2="18" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={colors[0]} />
            <Stop offset="1" stopColor={colors[1]} />
          </LinearGradient>
        </Defs>
        <Circle cx={10} cy={10} r={10} fill={`url(#avatar-${repo.id})`} />
      </Svg>
      <View
        style={{
          position: 'absolute',
          inset: 0,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: '#FFFFFF', fontSize: 8, fontWeight: '700' }}>{repo.avatarInitial}</Text>
      </View>
    </View>
  );
}

export default function RepoCard({ repo, onPress, showMetrics = true }: RepoCardProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityHint="Opens this repository"
      accessibilityLabel={`Open ${repo.name} by ${repo.author}`}
      accessibilityRole="link"
      onPress={onPress}
      style={{
        borderRadius: 16,
        backgroundColor: '#1C1C1E',
        padding: 14,
      }}
    >
      <Text
        style={{
          color: '#FFFFFF',
          fontSize: 14,
          fontWeight: '600',
          letterSpacing: 0,
          lineHeight: 18.9,
        }}
      >
        {repo.name}
      </Text>
      <Text
        style={{
          color: 'rgba(235, 235, 245, 0.55)',
          fontSize: 11.5,
          lineHeight: 16.675,
          marginTop: 5,
        }}
      >
        {repo.description}
      </Text>
      {showMetrics ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <StarIcon />
            <Text style={{ color: 'rgba(235, 235, 245, 0.55)', fontSize: 11.5, fontWeight: '500' }}>{repo.stars}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <ForkIcon />
            <Text style={{ color: 'rgba(235, 235, 245, 0.55)', fontSize: 11.5, fontWeight: '500' }}>{repo.forks}</Text>
          </View>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 11 }}>
        <GradientAvatar repo={repo} />
        <Text style={{ color: 'rgba(235, 235, 245, 0.6)', fontSize: 12, fontWeight: '500' }}>{repo.author}</Text>
      </View>
    </Pressable>
  );
}
