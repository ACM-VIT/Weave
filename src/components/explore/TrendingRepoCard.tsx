import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ExploreRepository } from '@/api/explore-data';

function TrendingRepoCard({ repo, rank, onPress }: { repo: ExploreRepository; rank?: number; onPress?: () => void }): React.JSX.Element {
  const position = repo.trend?.rank ?? rank;
  const podium = position !== undefined && position <= 3;
  const accent = position === 1 ? '#FFD60A' : position === 2 ? '#D6DBE5' : '#DFA477';
  const velocity = repo.trend?.velocity;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${position ? `Rank ${position}, ` : ''}${repo.author}/${repo.name}`} onPress={onPress}
    style={({ pressed }) => ({ padding: podium ? 18 : 14, borderRadius: 16, backgroundColor: '#1C1C1E',
      borderWidth: podium ? 1 : 0, borderColor: podium ? accent : 'transparent', opacity: pressed ? 0.75 : 1,
      flexDirection: 'row', alignItems: 'flex-start', gap: 12 })}>
    {position ? <Text style={{ width: podium ? 38 : 28, color: podium ? accent : '#A0A0AA', fontSize: podium ? 32 : 18, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{position}</Text> : null}
    <View style={{ flex: 1, gap: 5 }}>
      {podium ? <Text style={{ color: accent, fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>TOP {position} · TRENDING</Text> : null}
      <Text numberOfLines={1} style={{ color: '#FFFFFF', fontSize: podium ? 18 : 15, fontWeight: '700' }}>{`${repo.author}/${repo.name}`}</Text>
      <Text numberOfLines={podium ? 2 : 1} style={{ color: '#B8B8C0', fontSize: 13, lineHeight: 19 }}>{repo.description}</Text>
      <Text numberOfLines={2} style={{ color: '#B8B8C0', fontSize: 12, lineHeight: 18 }}>
        {repo.language ? `${repo.language}  ·  ` : ''}★ {repo.stars}  ·  {repo.forks} forks
        {typeof velocity === 'number' && Number.isFinite(velocity) ? `  ·  ${velocity.toFixed(1)} momentum` : ''}
      </Text>
    </View>
  </Pressable>;
}
export default memo(TrendingRepoCard);
