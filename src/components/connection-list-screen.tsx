import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ConnectionType } from '@/api/connections';
import { REFERENCE_THEME } from '@/constants/theme';
import { useAuth } from '@/store/AuthContext';
import { ConnectionList } from './connection-list';

export default function ConnectionListScreen({ type }: { type: ConnectionType }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { checkOnboardingStatus } = useAuth();
  const { username, userId } = useLocalSearchParams<{
    username?: string;
    userId?: string;
  }>();
  const title = type === 'followers' ? 'Followers' : 'Following';

  return (
    <View style={styles.screen}>
      <View
        style={[
          styles.content,
          {
            width: width >= 768 ? '68%' : '100%',
            paddingTop: Math.max(insets.top, 18),
          },
        ]}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Go back"
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => router.back()}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
          >
            <ArrowLeft color={REFERENCE_THEME.text} size={26} />
          </Pressable>
          <View style={styles.heading}>
            <Text style={styles.title}>{title}</Text>
            {username ? (
              <Text numberOfLines={1} selectable style={styles.subtitle}>
                @{username.replace(/^@/, '')}
              </Text>
            ) : null}
          </View>
          <View style={styles.headerSpacer} />
        </View>

        <ConnectionList
          contentPaddingBottom={Math.max(insets.bottom, 24)}
          onFollowingCountChange={() => void checkOnboardingStatus()}
          type={type}
          userId={userId}
          username={username}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: REFERENCE_THEME.background,
  },
  content: {
    flex: 1,
    maxWidth: 650,
  },
  header: {
    minHeight: 68,
    paddingHorizontal: 18,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  heading: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  title: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 24,
    lineHeight: 29,
  },
  subtitle: {
    marginTop: 1,
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-Regular',
    fontSize: 12,
    lineHeight: 16,
  },
  headerSpacer: {
    width: 44,
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.97 }],
  },
});
