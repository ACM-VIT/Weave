import { View } from 'react-native';
import { GitHubUnlinkPanel } from '../../components/onboarding/GitHubUnlinkPanel';
import { Stack } from "expo-router";
import { OnboardingProvider, useOnboarding } from "../../store/OnboardingContext";
import { useAuth } from '../../store/AuthContext';

export default function OnboardingLayout() {
  const { user } = useAuth();
  return (
    <OnboardingProvider key={user?.user_id ?? 'signed-out'}>
      <OnboardingContent />
    </OnboardingProvider>
  );
}

function OnboardingContent() {
  const { user, checkOnboardingStatus } = useAuth();
  const { invalidateGitHubImport } = useOnboarding();
  return (
    <View style={{ flex: 1 }}>
      {user ? <GitHubUnlinkPanel userId={user.user_id} onSaved={async () => { await checkOnboardingStatus(); invalidateGitHubImport(); }} recoveryOnly /> : null}
      <View style={{ flex: 1 }}><Stack screenOptions={{ headerShown: false }} /></View>
    </View>
  );
}
