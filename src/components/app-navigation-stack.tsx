import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { REFERENCE_THEME } from '@/constants/theme';

export function AppNavigationStack() {
  return <Stack screenOptions={({ route }) => ({
    headerShown: false,
    // Keep the covered web list measured instead of collapsing it with display:none.
    ...(Platform.OS === 'web' && route.name === 'repository/[repoId]' ? {
      presentation: 'transparentModal',
      contentStyle: { backgroundColor: REFERENCE_THEME.background },
    } : {}),
  })} />;
}
