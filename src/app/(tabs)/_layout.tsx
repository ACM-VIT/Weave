import { Tabs } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import HomeIcon from '../../assets/icons/Vector (1).svg';
import CompassIcon from '../../assets/icons/material-symbols_explore-outline.svg';
import UserIcon from '../../assets/icons/Vector (2).svg';
import { APP_THEME } from '../../constants/theme';
import { getResponsiveContainerStyle } from '../../components/responsive-layout';

export default function TabsLayout() {
  const { width } = useWindowDimensions();
  const responsiveTabBarStyle = getResponsiveContainerStyle(width);

  return (
    <Tabs
      initialRouteName="explore"
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: APP_THEME.tabBarBackground,
          borderTopColor: APP_THEME.tabBarBorder,
          height: 60,
          ...responsiveTabBarStyle,
        },
        tabBarItemStyle: {
          justifyContent: 'center',
          alignItems: 'center',
          height: 60,
          paddingTop: 0,
          paddingBottom: 0,
        },
        tabBarIconStyle: {
          justifyContent: 'center',
          alignItems: 'center',
          alignSelf: 'center',
          marginTop: 0,
          marginBottom: 0,
        },
        tabBarShowLabel: false,
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => (
            <HomeIcon fill={focused ? APP_THEME.activeAccent : APP_THEME.inactiveAccent} width={24} height={24} />
          ),
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Trending',
          tabBarIcon: ({ focused }) => (
            <CompassIcon fill={focused ? APP_THEME.activeAccent : APP_THEME.inactiveAccent} width={30} height={31} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ focused }) => (
            <UserIcon fill={focused ? APP_THEME.activeAccent : APP_THEME.inactiveAccent} width={22} height={22} />
          ),
        }}
      />
    </Tabs>
  );
}
