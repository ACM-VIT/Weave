import { passwordPolicyError, PASSWORD_REQUIREMENTS } from '@/utils/password-policy';
import { KeyboardForm } from '@/components/keyboard/keyboard-layout';
import { confirmPasswordReset } from '@/api/auth';
import LoginInput from '@/components/Auth/LoginInput';
import PrimaryButton from '@/components/Auth/PrimaryButton';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const isActive = useRef(false);
  const params = useLocalSearchParams<{
    access_token?: string;
    refresh_token?: string;
    error_description?: string;
  }>();
  const webHash = Platform.OS === 'web' && typeof window !== 'undefined'
    ? new URLSearchParams(window.location.hash.replace(/^#/, ''))
    : null;
  const [accessToken, setAccessToken] = useState(
    () => params.access_token ?? webHash?.get('access_token') ?? '',
  );
  const [refreshToken, setRefreshToken] = useState(
    () => params.refresh_token ?? webHash?.get('refresh_token') ?? '',
  );
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [isComplete, setIsComplete] = useState(false);
  const [handoffError, setHandoffError] = useState('');
  const [error, setError] = useState(
    () => params.error_description ?? webHash?.get('error_description') ?? '',
  );

  const passwordError = passwordPolicyError(password);
  const validPassword = passwordError === null;
  const isValid = Boolean(accessToken && refreshToken) && validPassword && password === confirmation;

  useEffect(() => {
    isActive.current = true;
    return () => { isActive.current = false; };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const cleanUrl = new URL(window.location.href);
    cleanUrl.hash = '';
    cleanUrl.searchParams.delete('access_token');
    cleanUrl.searchParams.delete('refresh_token');
    window.history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}`);
  }, []);

  const returnToApp = async () => {
    if (!isActive.current) return;
    if (Platform.OS !== 'web') {
      router.replace('/(auth)/login');
      return;
    }
    setHandoffError('');
    try {
      // Use the installed app scheme from app.json. createURL produces an
      // HTTPS URL on web, which would keep the user in this browser.
      // Navigate this tab so the handoff does not depend on popup permission.
      window.location.assign('ghsocial://login');
    } catch {
      setHandoffError('Unable to open Weave. Open the installed app to sign in, or continue in this browser.');
    }
  };

  const submit = async () => {
    if (!isValid || isLoading) return;
    setIsLoading(true);
    setError('');
    try {
      const successMessage = await confirmPasswordReset(accessToken, refreshToken, password);
      if (!isActive.current) return;
      setMessage(successMessage);
      setAccessToken('');
      setRefreshToken('');
      setPassword('');
      setConfirmation('');
      setIsComplete(true);
      void returnToApp();
    } catch (caught) {
      if (!isActive.current) return;
      setError(caught instanceof Error ? caught.message : 'Unable to reset your password.');
    } finally {
      if (isActive.current) setIsLoading(false);
    }
  };

  return (
    <KeyboardForm className="flex-1 bg-black" contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}>
      <View className="justify-center py-6 px-8 w-full max-w-[450px] self-center">
        <Text className="text-white text-[30px] font-nataBold">{isComplete ? 'Password updated' : 'Choose a new password'}</Text>
        {isComplete ? <>
          <Text accessibilityLiveRegion="polite" className="text-[#63E08A] text-[14px] leading-6 font-nata mt-3">{message}</Text>
          <Text className="text-[#8A898F] text-[14px] leading-6 font-nata mt-3 mb-6">
            Return to Weave and sign in with your new password. If the app didn’t open automatically, tap below.
          </Text>
          <PrimaryButton label="Open Weave" onPress={() => void returnToApp()} />
          {handoffError ? <Text accessibilityRole="alert" className="text-[#FF6878] text-[13px] font-nata mt-4">{handoffError}</Text> : null}
        </> : <>
          <Text className="text-[#8A898F] text-[14px] leading-6 font-nata mt-3 mb-8">
            {PASSWORD_REQUIREMENTS} Avoid reusing a password from another service.
          </Text>
          {(!accessToken || !refreshToken) && !isComplete ? <Text className="text-[#FF6878] text-[13px] font-nata mb-5">This reset link is invalid or expired.</Text> : null}
          <Text className="text-white text-[15px] font-nata mb-3">New Password</Text>
          <LoginInput value={password} onChangeText={setPassword} placeholder="Enter a new password" autoComplete="new-password" secureTextEntry />
          {password && passwordError ? <Text className="text-[#FF6878] text-[13px] font-nata mt-4">{passwordError}</Text> : null}
          <Text className="text-white text-[15px] font-nata mt-6 mb-3">Confirm Password</Text>
          <LoginInput value={confirmation} onChangeText={setConfirmation} placeholder="Repeat the new password" autoComplete="new-password" secureTextEntry />
          {confirmation && password !== confirmation ? <Text className="text-[#FF6878] text-[13px] font-nata mt-4">Passwords do not match.</Text> : null}
          {error ? <Text className="text-[#FF6878] text-[13px] font-nata mt-4">{error}</Text> : null}
          <View className="mt-7">
            <PrimaryButton label={isLoading ? 'Updating…' : 'Update password'} disabled={!isValid || isLoading} onPress={() => void submit()} />
          </View>
        </>}
        <Pressable onPress={() => {
          isActive.current = false;
          router.replace('/(auth)/login');
        }} className="items-center py-5 mt-2">
          <Text className="text-[#63E08A] font-nataSemiBold">{isComplete && Platform.OS === 'web' ? 'Continue in browser' : 'Go to login'}</Text>
        </Pressable>
      </View>
    </KeyboardForm>
  );
}
