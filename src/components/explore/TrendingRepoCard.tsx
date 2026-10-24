import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { RepositoryDetail } from '@/models/repository';
import { formatCompactCount } from '@/utils/format-count';
import { README_SUMMARY_PENDING } from '@/utils/readme';

interface TrendingRepoCardProps {
  repo: RepositoryDetail;
  rank?: number;
  onPress?: () => void;
}

function BookIcon(): React.JSX.Element {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15Z"
        stroke="rgba(235,235,245,0.75)"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"
        stroke="rgba(235,235,245,0.75)"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function StarIcon(): React.JSX.Element {
  return (
    <Svg width={11} height={11} viewBox="0 0 24 24" fill="#FFD60A">
      <Path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2Z" />
    </Svg>
  );
}

function TrendingRepoCard({ repo, rank, onPress }: TrendingRepoCardProps): React.JSX.Element {
  const position = repo.trend?.rank ?? rank;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${position ? `Rank ${position}, ` : ''}${repo.fullName}`}
      onPress={onPress}
      style={{
        minHeight: 52,
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 14,
        backgroundColor: '#1C1C1E',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <BookIcon />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Text
            numberOfLines={1}
            style={{
              color: '#FFFFFF',
              fontSize: 14,
              fontWeight: '600',
              letterSpacing: 0,
              flexShrink: 1,
            }}
          >
            {repo.name}
          </Text>
          {position !== undefined && position <= 3 ? (
            <Text style={{ color: 'rgb(255, 214, 10)', fontSize: 10.5, fontWeight: '700', flexShrink: 0 }}>
              No. {position}
            </Text>
          ) : null}
        </View>
        <Text
          numberOfLines={2}
          style={{
            color: 'rgba(235, 235, 245, 0.55)',
            fontSize: 11.5,
            lineHeight: 16.1,
            marginTop: 2,
          }}
        >
          {repo.readmeSummary || repo.description || README_SUMMARY_PENDING}
        </Text>
      </View>
      <View style={{ width: 48, flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <StarIcon />
        <Text style={{ color: 'rgba(235, 235, 245, 0.45)', fontSize: 12 }}>{formatCompactCount(repo.stats.stars)}</Text>
      </View>
    </Pressable>
  );
}

export default memo(TrendingRepoCard);
