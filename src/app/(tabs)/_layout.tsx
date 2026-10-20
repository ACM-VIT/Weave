import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tabs } from 'expo-router';
import { Home, Search, User } from 'lucide-react-native';

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      initialRouteName="home"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#8EFF7A',
        tabBarInactiveTintColor: '#FFFFFF',
        tabBarStyle: {
          backgroundColor: '#090B08',
          borderTopColor: '#090B08',
          borderTopWidth: 0.5,
          height: 64 + Math.max(insets.bottom, 12),
          paddingTop: 10,
          paddingHorizontal: 8,
          paddingBottom: Math.max(insets.bottom, 12),
          elevation: 0,
          boxShadow: 'none',
        },
        tabBarItemStyle: {
          paddingTop: 2,
          paddingBottom: 0,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '500',
          marginTop: 4,
        },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <Home color={color} size={24} strokeWidth={1.8} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarHideOnKeyboard: true,
          tabBarIcon: ({ color }) => <Search color={color} size={24} strokeWidth={1.8} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color }) => <User color={color} size={24} strokeWidth={1.8} />,
        }}
      />
    </Tabs>
  );
}
