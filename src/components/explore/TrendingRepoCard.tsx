import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { RepositoryDetail } from '@/models/repository';
import { formatCompactCount } from '@/utils/format-count';
import { README_SUMMARY_PENDING } from '@/utils/readme';

function TrendingRepoCard({ repo, rank, onPress }: { repo: RepositoryDetail; rank?: number; onPress?: () => void }): React.JSX.Element {
  const position = repo.trend?.rank ?? rank;
  const podium = position !== undefined && position <= 3;
  const accent = position === 1 ? '#FFD60A' : position === 2 ? '#D6DBE5' : '#DFA477';
  const velocity = repo.trend?.features.trend_velocity;
  return <Pressable cssInterop={false} accessibilityRole="button" accessibilityLabel={`${position ? `Rank ${position}, ` : ''}${repo.fullName}`} onPress={onPress}
    style={({ pressed }) => ({ padding: podium ? 18 : 14, borderRadius: 16, backgroundColor: '#1C1C1E',
      borderWidth: 1, borderColor: podium ? accent : '#3A3A3C', opacity: pressed ? 0.75 : 1,
      flexDirection: 'row', alignItems: 'flex-start', gap: 12 })}>
    {position ? <Text style={{ width: podium ? 38 : 28, color: podium ? accent : '#A0A0AA', fontSize: podium ? 32 : 18, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{position}</Text> : null}
    <View style={{ flex: 1, gap: 5 }}>
      {podium ? <Text style={{ color: accent, fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>TOP {position} · TRENDING</Text> : null}
      <Text numberOfLines={1} style={{ color: '#FFFFFF', fontSize: podium ? 18 : 15, fontWeight: '700' }}>{repo.fullName}</Text>
      <Text numberOfLines={podium ? 2 : 1} style={{ color: '#B8B8C0', fontSize: 13, lineHeight: 19 }}>{repo.readmeSummary || repo.description || README_SUMMARY_PENDING}</Text>
      <Text numberOfLines={2} style={{ color: '#B8B8C0', fontSize: 12, lineHeight: 18 }}>
        {repo.primaryLanguage ? `${repo.primaryLanguage}  ·  ` : ''}★ {formatCompactCount(repo.stats.stars)}  ·  {formatCompactCount(repo.stats.forks)} forks
        {typeof velocity === 'number' && Number.isFinite(velocity) ? `  ·  ${velocity.toFixed(1)} momentum` : ''}
        {repo.trend?.score != null ? `  ·  Score ${repo.trend.score.toFixed(2)}` : ''}
      </Text>
    </View>
  </Pressable>;
}
export default memo(TrendingRepoCard);
