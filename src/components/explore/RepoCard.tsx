import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import GitBranchIcon from '../../assets/icons/git-branch.svg';
import StarIcon from '../../assets/icons/star.svg';
import { Repo } from '../../types';
import Avatar from '../Avatar';

interface RepoCardProps {
  repo: Repo;
  onPress?: () => void;
}

const regular = { fontFamily: 'NataSans-Regular' };
const bold = { fontFamily: 'NataSans-Bold' };

export default function RepoCard({ repo, onPress }: RepoCardProps): React.JSX.Element {
  // Replace hyphens with hyphen + space to guarantee wrapping on hyphens across all platforms
  const formattedName = repo.name.replace(/-/g, '- ');

  // Dynamic sizing: long names get a larger font size to emphasize wrapping/height,
  // short names get a smaller font size to keep the box compact.
  const isLongName = repo.name.length > 25;
  const titleFontSize = isLongName ? 14 : 12;
  const titleLineHeight = isLongName ? 18 : 16;

  return (
    <TouchableOpacity
      onPress={onPress}
      className="rounded-xl p-4"
      style={{
        backgroundColor: '#191F18',
        borderColor: '#2E3D2E',
        borderWidth: 1,
      }}
      activeOpacity={0.7}
    >
      <Text
        className="text-white mb-2"
        style={[bold, { fontSize: titleFontSize, lineHeight: titleLineHeight, width: '100%' }]}
      >
        {formattedName}
      </Text>
      <View className="flex-row items-center" style={{ gap: 10 }}>
        <View className="flex-row items-center" style={{ gap: 3 }}>
          <StarIcon stroke="#FBBF24" fill="#FBBF24" width={11} height={11} />
          <Text className="text-[#A3A3A3] text-xs" style={regular}>{repo.stars}</Text>
        </View>
        <View className="flex-row items-center" style={{ gap: 3 }}>
          <GitBranchIcon stroke="#A3A3A3" width={11} height={11} />
          <Text className="text-[#A3A3A3] text-xs" style={regular}>{repo.forks}</Text>
        </View>
      </View>
      <View className="flex-row items-center mt-2" style={{ gap: 5 }}>
        <Avatar color={repo.avatarColor} initial={repo.avatarInitial} size={16} author={repo.author} />
        <Text className="text-[#6B7280] text-xs" style={regular}>{repo.author}</Text>
      </View>
    </TouchableOpacity>
  );
}
