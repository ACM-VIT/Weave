import { View } from 'react-native';
import { GitHubUnlinkPanel } from '../../components/onboarding/GitHubUnlinkPanel';
import { Stack } from "expo-router";
import { OnboardingProvider } from "../../store/OnboardingContext";
import { useAuth } from '../../store/AuthContext';

export default function OnboardingLayout() {
  const { user, checkOnboardingStatus } = useAuth();
  return (
    <OnboardingProvider key={user?.user_id ?? 'signed-out'}>
      <View style={{ flex: 1 }}>
        {user ? <GitHubUnlinkPanel userId={user.user_id} onSaved={checkOnboardingStatus} recoveryOnly /> : null}
        <View style={{ flex: 1 }}><Stack screenOptions={{ headerShown: false }} /></View>
      </View>
    </OnboardingProvider>
  );
}
