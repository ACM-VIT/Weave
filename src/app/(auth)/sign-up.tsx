import { useRouter } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';

import AuthFooter from '@/components/Auth/AuthFooter';
import { GithubIcon, GoogleIcon, MailIcon } from '@/components/Auth/icons';
import LogoCircle from '@/components/Auth/LogoCircle';
import OrDivider from '@/components/Auth/OrDivider';
import SocialButton from '@/components/Auth/SocialButton';

export default function SignUpScreen() {
  const router = useRouter();

  return (
    <View className="flex-1 bg-[#0A0C09]">
      <ScrollView
        contentContainerStyle={{
          paddingBottom: 48,
          paddingHorizontal: 30,
          flexGrow: 1,
          justifyContent: 'center',
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="items-center mb-10">
          <LogoCircle size={190} />
        </View>

        <View className="mb-10 items-center">
          <Text className="text-white text-3xl leading-tight text-center font-nataBold">
            Join the{' '}
            <Text className="text-[#6DA963] font-nataBold">dev community</Text>
          </Text>
          <Text className="text-white/50 text-sm mt-2 text-center font-nata">
            Connect. Collaborate. Work Together.
          </Text>
        </View>

        <View className="gap-y-3">
          <SocialButton
            label="Continue with GitHub"
            icon={<GithubIcon size={20} color="#ffffff" />}
            showChevron
          />
          <SocialButton
            label="Continue with Google"
            icon={<GoogleIcon size={20} />}
            showChevron
          />
          <SocialButton
            label="Continue with Email"
            icon={<MailIcon size={20} color="#6DA963" />}
            showChevron
            onPress={() => router.push('/(auth)/sign-up-email')}
          />
        </View>

        <View className="mt-8 mb-6">
          <OrDivider />
        </View>

        <AuthFooter
          prompt="Already have an account?"
          linkLabel="Log in"
          onPress={() => router.push('/(auth)/login')}
        />

        <Text className="text-white/30 text-[16px] text-center mt-6 leading-6 font-nata">
          By signing up, you agree to our{'\n'}
          <Text className="text-[#6DA963] font-nata">Terms of Service</Text>{' '}
          and <Text className="text-[#6DA963] font-nata">Privacy Policy</Text>.
        </Text>
      </ScrollView>
    </View>
  );
}
