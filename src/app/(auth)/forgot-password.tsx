import { KeyboardForm } from '@/components/keyboard/keyboard-layout';
import { requestPasswordReset } from '@/api/auth';
import LoginInput from '@/components/Auth/LoginInput';
import PrimaryButton from '@/components/Auth/PrimaryButton';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submit = async () => {
    if (!isValid || isLoading) return;
    setIsLoading(true);
    setError('');
    try {
      setMessage(await requestPasswordReset(email.trim()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to request a password reset.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardForm className="flex-1 bg-black" contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}>
      <View className="justify-center py-6 px-8 w-full max-w-[450px] self-center">
        <Text className="text-white text-[30px] font-nataBold">Reset your password</Text>
        <Text className="text-[#8A898F] text-[14px] leading-6 font-nata mt-3 mb-8">
          Enter your account email and we’ll send a secure reset link if an account exists.
        </Text>
        <Text className="text-white text-[15px] font-nata mb-3">Email Address</Text>
        <LoginInput value={email} onChangeText={setEmail} placeholder="Enter your email" keyboardType="email-address" autoCapitalize="none" />
        {message ? <Text className="text-[#63E08A] text-[13px] font-nata mt-4">{message}</Text> : null}
        {error ? <Text className="text-[#FF6878] text-[13px] font-nata mt-4">{error}</Text> : null}
        <View className="mt-7">
          <PrimaryButton label={isLoading ? 'Sending…' : 'Send reset link'} disabled={!isValid || isLoading} onPress={() => void submit()} />
        </View>
        <Pressable onPress={() => router.replace('/(auth)/login')} className="items-center py-5 mt-2">
          <Text className="text-[#63E08A] font-nataSemiBold">Back to login</Text>
        </Pressable>
      </View>
    </KeyboardForm>
  );
}
