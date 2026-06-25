import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import GitBranchIcon from '../../assets/icons/git-branch.svg';
import MonitorIcon from '../../assets/icons/monitor.svg';
import StarIcon from '../../assets/icons/star.svg';
import { Repo } from '../../types';
import Avatar from '../Avatar';

interface FeaturedRepoCardProps {
  repo: Repo;
  onPress?: () => void;
}

const regular = { fontFamily: 'NotoSans_400Regular' };
const bold = { fontFamily: 'NotoSans_700Bold' };

export default function FeaturedRepoCard({ repo, onPress }: FeaturedRepoCardProps): React.JSX.Element {
  return (
    <TouchableOpacity
      onPress={onPress}
      className="rounded-xl p-4 mb-3"
      style={{
        backgroundColor: '#191F18',
        borderColor: '#2E3D2E',
        borderWidth: 1,
      }}
      activeOpacity={0.7}
    >
      <View className="flex-row items-center mb-3" style={{ gap: 10 }}>
        <View className="w-9 h-9 bg-[#142918] rounded-lg items-center justify-center border border-[#1B4322]">
          <MonitorIcon stroke="#6DA963" width={18} height={18} />
        </View>
        <Text className="text-white text-sm flex-1" numberOfLines={1} style={bold}>
          {repo.name}
        </Text>
      </View>
      <View className="flex-row items-center" style={{ gap: 16 }}>
        <View className="flex-row items-center" style={{ gap: 4 }}>
          <StarIcon stroke="#FBBF24" fill="#FBBF24" width={13} height={13} />
          <Text className="text-[#9CA3AF] text-xs" style={regular}>{repo.stars}</Text>
        </View>
        <View className="flex-row items-center" style={{ gap: 4 }}>
          <GitBranchIcon stroke="#9CA3AF" width={13} height={13} />
          <Text className="text-[#9CA3AF] text-xs" style={regular}>{repo.forks}</Text>
        </View>
        <View className="flex-row items-center ml-auto" style={{ gap: 5 }}>
          <Avatar color={repo.avatarColor} initial={repo.avatarInitial} size={18} author={repo.author} />
          <Text className="text-[#6B7280] text-xs" style={regular}>{repo.author}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}