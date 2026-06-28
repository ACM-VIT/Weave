import React from 'react';
import { useRouter } from 'expo-router';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Compass, House, User } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface BottomNavProps {
  activeTab: 'home' | 'discover' | 'profile';
  onTabPress: (tab: 'home' | 'discover' | 'profile') => void;
}

export function BottomNav({ activeTab, onTabPress }: BottomNavProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabs = [
    { id: 'home' as const, Icon: House },
    { id: 'discover' as const, Icon: Compass },
    { id: 'profile' as const, Icon: User },
  ];
  const routes = {
    home: '/(tabs)/home',
    discover: '/(tabs)/explore',
    profile: '/(tabs)/profile',
  } as const;

  return (
    <View
      style={[
        styles.root,
        { paddingBottom: Platform.OS === 'web' ? 12 : Math.max(insets.bottom, 10) },
      ]}
    >
      <View style={styles.tabs}>
        {tabs.map(({ id, Icon }) => {
          const selected = activeTab === id;
          return (
            <Pressable
              key={id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => {
                onTabPress(id);
                if (id !== activeTab) {
                  router.navigate(routes[id]);
                }
              }}
              style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
            >
              <Icon
                color={selected ? '#6DA963' : '#FFFFFF'}
                size={selected ? 31 : 28}
                strokeWidth={selected ? 2.5 : 2.4}
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    backgroundColor: '#090B08',
  },
  tabs: {
    height: 45,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 42,
  },
  tab: {
    width: 54,
    height: 45,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.97 }],
  },
});
