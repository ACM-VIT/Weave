import { Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useOAuth } from '../../hooks/useOAuth';

import AuthFooter from '@/components/Auth/AuthFooter';
import BrandWord from '@/components/Auth/BrandWord';
import { GithubIcon, GoogleIcon, MailIcon } from '@/components/Auth/icons';
import LogoCircle from '@/components/Auth/LogoCircle';
import OrDivider from '@/components/Auth/OrDivider';
import SocialButton from '@/components/Auth/SocialButton';
import DateOfBirthField from '@/components/Auth/date-of-birth-field';
import SectionLabel from '@/components/Auth/SectionLabel';
import { isValidDateOfBirth } from '@/utils/date-of-birth';

export default function SignUpScreen() {
  const router = useRouter();
  const { signInWithProvider, isLoading: oauthLoading, error: oauthError } = useOAuth();
  const [dateOfBirth, setDateOfBirth] = useState('');
  const isDateOfBirthValid = isValidDateOfBirth(dateOfBirth);

  return (
    <View className="flex-1 bg-[#000000]">
      <ScrollView
        contentContainerStyle={{
          paddingBottom: 48,
          paddingHorizontal: 30,
          flexGrow: 1,
          justifyContent: 'center',
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ maxWidth: 450, width: '100%', alignSelf: 'center' }}>
          <View className="items-center mb-10">
            <LogoCircle size={190} />
          </View>

        <View className="mb-10 items-center">
          <Text className="text-white text-3xl leading-tight text-center font-nataBold">
            Join{' '}
            <BrandWord className="font-nataBold" />
          </Text>
          <Text className="text-[rgba(235,235,245,0.6)] text-sm mt-2 text-center font-nata">
            Connect. Collaborate. Work Together.
          </Text>
        </View>

        <View className="mb-6">
          <SectionLabel title="Date of Birth" />
          <DateOfBirthField value={dateOfBirth} onChange={setDateOfBirth} />
          {dateOfBirth.length > 0 && !isDateOfBirthValid ? (
            <Text className="text-[#FF453A] text-[13px] font-nata mt-1 ml-1">
              Select a valid date of birth.
            </Text>
          ) : null}
        </View>

        <View className="gap-y-3">
          <SocialButton
            label={oauthLoading ? "Opening..." : "Continue with GitHub"}
            icon={
              <GithubIcon
                size={20}
                color={oauthLoading ? "rgba(235,235,245,0.35)" : "#FFFFFF"}
              />
            }
            showChevron
            disabled={oauthLoading || !isDateOfBirthValid}
            onPress={() => signInWithProvider('github', 'signup', dateOfBirth)}
          />
          <SocialButton
            label={oauthLoading ? "Opening..." : "Continue with Google"}
            icon={<GoogleIcon size={20} />}
            showChevron
            disabled={oauthLoading || !isDateOfBirthValid}
            onPress={() => signInWithProvider('google', 'signup', dateOfBirth)}
          />
          <SocialButton
            label="Continue with Email"
            icon={<MailIcon size={20} color="#63E08A" />}
            showChevron
            onPress={() => router.push('/(auth)/sign-up-email')}
          />
        </View>

        {oauthError ? (
          <Text className="text-[#FF453A] text-[13px] font-nata mt-3 text-center">
            {oauthError}
          </Text>
        ) : null}

        <View className="mt-8 mb-6">
          <OrDivider />
        </View>

        <AuthFooter
          prompt="Already have an account?"
          linkLabel="Log in"
          onPress={() => router.push('/(auth)/login')}
        />

        <Text className="text-[rgba(235,235,245,0.3)] text-[16px] text-center mt-6 leading-6 font-nata">
          By signing up, you agree to our{'\n'}
          <Text accessibilityRole="link" onPress={() => router.push('/terms' as Href)} className="text-[#63E08A] font-nata">Terms of Service</Text>{' '}
          and <Text accessibilityRole="link" onPress={() => router.push('/privacy' as Href)} className="text-[#63E08A] font-nata">Privacy Policy</Text>.
        </Text>
        </View>
      </ScrollView>
    </View>
  );
}
