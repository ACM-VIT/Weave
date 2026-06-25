import React from 'react';
import { TextInput, View } from 'react-native';
import SearchIcon from '../../assets/icons/search.svg';

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
}

export default function SearchBar({
  value,
  onChangeText,
  placeholder = 'Explore',
}: SearchBarProps): React.JSX.Element {
  return (
    <View className="flex-row items-center bg-[#1C1C1E] border border-white rounded-full px-4 py-2.5 mx-4 mb-2">
      <SearchIcon stroke="#6B7280" width={16} height={16} />
      <TextInput
        className="flex-1 text-white text-sm ml-2"
        placeholder={placeholder}
        placeholderTextColor="#6B7280"
        value={value}
        onChangeText={onChangeText}
        style={{ fontFamily: 'NotoSans_400Regular' }}
      />
    </View>
  );
}