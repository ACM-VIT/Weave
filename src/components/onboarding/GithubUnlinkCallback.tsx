import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../store/AuthContext';
import { finishGithubUnlink } from '../../services/githubUnlink';
import { APP_THEME, Fonts, REFERENCE_THEME, Spacing } from '../../constants/theme';

export function GithubUnlinkCallback({ code, error }: { code?: string; error?: string }) {
  const { user, isLoading, checkOnboardingStatus } = useAuth();
  const router = useRouter();
  const userId = user?.user_id;
  const [message, setMessage] = useState('Verifying GitHub disconnect…');
  const [busy, setBusy] = useState(true);
  const flight = useRef<Promise<import('../../api/githubUnlink').GithubUnlinkResult> | null>(null);
  const owner = useRef<string | null>(null);
  const refreshed = useRef(false);
  useEffect(() => {
    if (isLoading) return;
    let active = true;
    const controller = new AbortController();
    const run = async () => {
      try {
        if (error || !code || !userId) {
          throw new Error(error === 'last_identity' ? 'GitHub is your only login identity. Add another login method before disconnecting it.' : 'Reauthentication failed or this account changed. Start again from your profile.');
        }
        if (!flight.current) { owner.current = userId; flight.current = finishGithubUnlink(userId, code, controller.signal); }
        if (owner.current !== userId) throw new Error('The account changed. Start again from your profile.');
        const result = await flight.current;
        if (!active) return;
        setMessage(result.status === 'done' ? 'GitHub login disconnected.' : result.message ?? 'Disconnect needs verification. Check its status from your profile.');
        if (result.status !== 'none' && !refreshed.current) {
          refreshed.current = true;
          try { await checkOnboardingStatus(); } catch (reason) { refreshed.current = false; throw reason; }
        }
      } catch (reason) { if (active) setMessage(reason instanceof Error ? reason.message : 'Check disconnect status from your profile.'); }
      finally { if (active) setBusy(false); }
    };
    void run();
    return () => { active = false; };
  }, [code, error, userId, isLoading, checkOnboardingStatus]);
  return <View style={{ flex: 1, backgroundColor: REFERENCE_THEME.background, padding: Spacing.six, justifyContent: 'center', gap: Spacing.three }}>
    <Text style={{ fontFamily: Fonts.sans, fontWeight: '600', fontSize: 22, color: REFERENCE_THEME.text }}>GitHub login</Text>
    <Text accessibilityRole="alert" style={{ fontFamily: Fonts.sans, fontSize: 15, lineHeight: 23, color: REFERENCE_THEME.text }}>{message}</Text>
    {busy ? <ActivityIndicator color={APP_THEME.primary} accessibilityLabel="Verifying disconnect" /> : <Pressable accessibilityRole="button"
      onPress={() => router.replace(user ? user.onboarding_completed ? '/(tabs)/profile' : '/onboarding/create-profile' : '/(auth)/login')}
      style={{ minHeight: 48, justifyContent: 'center' }}><Text style={{ fontFamily: Fonts.sans, color: APP_THEME.primary }}>Return to account</Text></Pressable>}
  </View>;
}
