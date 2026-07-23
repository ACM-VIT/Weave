import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { TabName } from '../../types';

const TABS: TabName[] = ['Latest', 'Trending'];

interface TabBarProps {
  activeTab: TabName;
  onTabChange: (tab: TabName) => void;
}

export default function TabBar({ activeTab, onTabChange }: TabBarProps): React.JSX.Element {
  return (
    <View style={{ paddingTop: 12, paddingHorizontal: 20 }}>
      <View
        style={{
          flexDirection: 'row',
          backgroundColor: 'rgba(118, 118, 128, 0.18)',
          borderRadius: 9,
          padding: 2,
        }}
      >
        {TABS.map((tab) => {
          const isActive = activeTab === tab;

          return (
            <Pressable
              key={tab}
              onPress={() => onTabChange(tab)}
              style={{
                flex: 1,
                height: 30,
                borderRadius: 7,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: isActive ? 'rgb(99, 99, 102)' : 'transparent',
                boxShadow: isActive ? '0 2px 6px rgba(0, 0, 0, 0.3)' : 'none',
              }}
            >
              <Text
                style={{
                  color: isActive ? 'rgb(255, 255, 255)' : 'rgba(235, 235, 245, 0.6)',
                  fontSize: 13,
                  fontWeight: '600',
                }}
              >
                {tab}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
