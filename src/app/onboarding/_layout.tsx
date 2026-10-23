import { Stack } from "expo-router";
import { OnboardingProvider } from "../../store/OnboardingContext";
import { useAuth } from '../../store/AuthContext';

export default function OnboardingLayout() {
  const { user } = useAuth();
  return (
    <OnboardingProvider key={user?.user_id ?? 'signed-out'}>
      <Stack screenOptions={{ headerShown: false }} />
    </OnboardingProvider>
  );
}
