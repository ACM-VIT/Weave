import { KeyboardForm } from '@/components/keyboard/keyboard-layout';
import { confirmPasswordReset } from '@/api/auth';
import LoginInput from '@/components/Auth/LoginInput';
import PrimaryButton from '@/components/Auth/PrimaryButton';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

export default function ResetPasswordScreen() {
  const router = useRouter();
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
  const [error, setError] = useState(
    () => params.error_description ?? webHash?.get('error_description') ?? '',
  );

  const validPassword = password.length >= 12 && password.length <= 128;
  const isValid = Boolean(accessToken && refreshToken) && validPassword && password === confirmation;

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const cleanUrl = new URL(window.location.href);
    cleanUrl.hash = '';
    cleanUrl.searchParams.delete('access_token');
    cleanUrl.searchParams.delete('refresh_token');
    window.history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}`);
  }, []);

  const submit = async () => {
    if (!isValid || isLoading) return;
    setIsLoading(true);
    setError('');
    try {
      setMessage(await confirmPasswordReset(accessToken, refreshToken, password));
      setAccessToken('');
      setRefreshToken('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to reset your password.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardForm className="flex-1 bg-black" contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}>
      <View className="justify-center py-6 px-8 w-full max-w-[450px] self-center">
        <Text className="text-white text-[30px] font-nataBold">Choose a new password</Text>
        <Text className="text-[#8A898F] text-[14px] leading-6 font-nata mt-3 mb-8">
          Use at least 12 characters. Avoid reusing a password from another service.
        </Text>
        {(!accessToken || !refreshToken) && !message ? <Text className="text-[#FF6878] text-[13px] font-nata mb-5">This reset link is invalid or expired.</Text> : null}
        <Text className="text-white text-[15px] font-nata mb-3">New Password</Text>
        <LoginInput value={password} onChangeText={setPassword} placeholder="Enter a new password" autoComplete="new-password" secureTextEntry />
        <Text className="text-white text-[15px] font-nata mt-6 mb-3">Confirm Password</Text>
        <LoginInput value={confirmation} onChangeText={setConfirmation} placeholder="Repeat the new password" autoComplete="new-password" secureTextEntry />
        {confirmation && password !== confirmation ? <Text className="text-[#FF6878] text-[13px] font-nata mt-4">Passwords do not match.</Text> : null}
        {message ? <Text className="text-[#63E08A] text-[13px] font-nata mt-4">{message}</Text> : null}
        {error ? <Text className="text-[#FF6878] text-[13px] font-nata mt-4">{error}</Text> : null}
        <View className="mt-7">
          <PrimaryButton label={isLoading ? 'Updating…' : 'Update password'} disabled={!isValid || isLoading} onPress={() => void submit()} />
        </View>
        <Pressable onPress={() => router.replace('/(auth)/login')} className="items-center py-5 mt-2">
          <Text className="text-[#63E08A] font-nataSemiBold">Go to login</Text>
        </Pressable>
      </View>
    </KeyboardForm>
  );
}
