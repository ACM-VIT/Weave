import { KeyboardForm } from '@/components/keyboard/keyboard-layout';
import LogoCircle from '@/components/Auth/LogoCircle';
import PrimaryButton from '@/components/Auth/PrimaryButton';
import { type NativeStackNavigationProp, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';

/** Supabase verifies the link. App credentials are established only by normal login. */
export default function ConfirmEmailScreen() {
  const router = useRouter();
  const navigation = useNavigation<NativeStackNavigationProp<{
    'confirm-email': Record<string, string | undefined>;
  }>>();
  const params = useLocalSearchParams<{error?: string; error_description?: string}>();
  const [failed] = useState(() => Boolean(params.error || params.error_description || (
    Platform.OS === 'web' && typeof window !== 'undefined'
    && new URLSearchParams(window.location.hash.slice(1)).get('error')
  )));
  const [appError, setAppError] = useState('');
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.hash = '';
    const keys = ['access_token','refresh_token','token_type','expires_in','expires_at','code','error','error_description'];
    for (const key of keys) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', url.pathname + url.search);
    // Clear the router's copy too, otherwise its next state sync restores the
    // original callback URL (including provider credentials).
    navigation.setParams({ ...Object.fromEntries(keys.map(key => [key, undefined])), '#': '' });
  }, [navigation]);
  return (
    <KeyboardForm className="flex-1 bg-black" contentContainerStyle={{flexGrow:1,justifyContent:'center',padding:32}}>
      <View className="w-full max-w-[450px] self-center">
        <LogoCircle size={56} />
        <Text className="text-white text-[28px] font-nataBold mt-6">{failed ? 'Confirmation link expired' : 'Continue to Weave'}</Text>
        <Text accessibilityRole={failed ? 'alert' : undefined} className="text-[#8A898F] text-[15px] leading-6 font-nata mt-3 mb-7">
          {failed ? 'This link is invalid or has expired. Return to signup to request another confirmation email.' : 'Sign in with your confirmed email to finish setting up your account.'}
        </Text>
        <PrimaryButton label={failed ? 'Return to signup' : 'Sign in'} onPress={()=>router.replace(failed ? '/(auth)/sign-up-email' : '/(auth)/login')} />
        {Platform.OS === 'web' && !failed ? <Pressable accessibilityRole="button" className="py-5 items-center" onPress={()=>{
          setAppError(''); void Linking.openURL('ghsocial://login').catch(()=>setAppError('Open the installed Weave app to sign in.'));
        }}><Text className="text-[#63E08A] font-nataSemiBold">Open Weave app</Text></Pressable> : null}
        {appError ? <Text accessibilityRole="alert" className="text-[#FF453A] font-nata">{appError}</Text> : null}
      </View>
    </KeyboardForm>
  );
}
