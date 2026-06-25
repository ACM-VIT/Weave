import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import GitBranchIcon from '../../assets/icons/git-branch.svg';
import MonitorIcon from '../../assets/icons/monitor.svg';
import StarIcon from '../../assets/icons/star.svg';
import { Repo } from '../../types';
import Avatar from '../Avatar';

interface TrendingRepoCardProps {
  repo: Repo;
  rank?: number;
  onPress?: () => void;
}

const regular = { fontFamily: 'NotoSans_400Regular' };
const bold = { fontFamily: 'NotoSans_700Bold' };

export default function TrendingRepoCard({ repo, onPress }: TrendingRepoCardProps): React.JSX.Element {
  const formattedName = repo.name.replace(/-/g, '- ');

  return (
    <TouchableOpacity
      onPress={onPress}
      className="rounded-xl"
      style={{
        backgroundColor: '#191F18',
        borderColor: '#2E3D2E',
        borderWidth: 1,
        padding: 18,
      }}
      activeOpacity={0.7}
    >
      {/* Row 1: Icon and Name */}
      <View className="flex-row items-center mb-2.5" style={{ gap: 8 }}>
        {repo.hasIcon && (
          <View className="w-7 h-7 bg-[#142918] rounded-md items-center justify-center border border-[#1B4322]">
            <MonitorIcon stroke="#6DA963" width={14} height={14} />
          </View>
        )}
        <Text
          className="text-white flex-1"
          numberOfLines={1}
          style={[bold, { fontSize: 14, lineHeight: 18, width: '100%' }]}
        >
          {formattedName}
        </Text>
      </View>

      {/* Row 2: Stars and Forks */}
      <View className="flex-row items-center mb-2.5" style={{ gap: 12 }}>
        <View className="flex-row items-center" style={{ gap: 4 }}>
          <StarIcon stroke="#FBBF24" fill="#FBBF24" width={12} height={12} />
          <Text className="text-[#A3A3A3] text-xs" style={regular}>{repo.stars}</Text>
        </View>
        <View className="flex-row items-center" style={{ gap: 4 }}>
          <GitBranchIcon stroke="#A3A3A3" width={12} height={12} />
          <Text className="text-[#A3A3A3] text-xs" style={regular}>{repo.forks}</Text>
        </View>
      </View>

      {/* Row 3: Author */}
      <View className="flex-row items-center" style={{ gap: 6 }}>
        <Avatar color={repo.avatarColor} initial={repo.avatarInitial} size={16} author={repo.author} />
        <Text className="text-[#A3A3A3] text-xs" style={regular}>{repo.author}</Text>
      </View>
    </TouchableOpacity>
  );
}