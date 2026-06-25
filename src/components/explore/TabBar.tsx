import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { TabName } from '../../types';

const TABS: TabName[] = ['For you', 'Trending'];

interface TabBarProps {
  activeTab: TabName;
  onTabChange: (tab: TabName) => void;
}

const regular = { fontFamily: 'NotoSans_400Regular' };
const bold = { fontFamily: 'NotoSans_700Bold' };

export default function TabBar({ activeTab, onTabChange }: TabBarProps): React.JSX.Element {
  return (
    <View className="flex-row justify-center mx-4 mt-4 mb-6" style={{ gap: 60 }}>
      {TABS.map((tab) => {
        const isActive = activeTab === tab;
        return (
          <TouchableOpacity
            key={tab}
            onPress={() => onTabChange(tab)}
            className="pb-3"
            style={{
              borderBottomWidth: isActive ? 2 : 0,
              borderBottomColor: isActive ? '#6DA963' : 'transparent',
            }}
          >
            <Text
              className="text-xs"
              style={[
                isActive ? bold : regular,
                { color: isActive ? '#6DA963' : '#8E8E93' }
              ]}
            >
              {tab}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}