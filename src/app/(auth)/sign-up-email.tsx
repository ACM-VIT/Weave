import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
    ScrollView,
    Text,
    View,
} from "react-native";

import AuthFooter from "@/components/Auth/AuthFooter";
import AuthInput from "@/components/Auth/AuthInput";
import EmailTab from "@/components/Auth/EmailTab";
import { GithubIcon, GoogleIcon } from "@/components/Auth/icons";
import LogoCircle from "@/components/Auth/LogoCircle";
import OrDivider from "@/components/Auth/OrDivider";
import PasswordRules from "@/components/Auth/PasswordRules";
import PrimaryButton from "@/components/Auth/PrimaryButton";
import SectionLabel from "@/components/Auth/SectionLabel";
import SocialButton from "@/components/Auth/SocialButton";

export default function SignUpEmail() {
  const router = useRouter();  
  const scrollViewRef = useRef<ScrollView>(null);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const hasMinLength = password.length >= 8;
  const hasNumber = /\d/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const isPasswordValid = hasMinLength && hasNumber && hasUppercase;
  const isFormValid = fullName.trim().length > 0 && email.trim().length > 0 && isPasswordValid;

  useEffect(() => {
    // Auto-scroll to bottom slowly on mount
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 500);
  }, []);

  return (
    <ScrollView
      ref={scrollViewRef}
      className="flex-1 bg-[#0A0C09]"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: 40 }}
    >
      <View className="px-8 pt-14">

        <View className="items-center">
            <LogoCircle />
        </View>

        <View className="mt-8 items-center">
          <Text className="font-nataBold text-white text-[28px] text-center">
            Create your
          </Text>

          <Text className="font-nataBold text-[#6DA963] text-[28px] text-center">
            developer profile
          </Text>

          <Text className="font-nata text-[#8A8A8A] text-center mt-4 text-[13px] leading-5">
            Join repositories and connect{"\n"}
            with developers around the world.
          </Text>
        </View>

        <View className="mt-10 gap-y-5">
            <SocialButton
                label="Continue with GitHub"
                icon={<GithubIcon />}
                showChevron
            />

            <SocialButton
                label="Continue with Google"
                icon={<GoogleIcon />}
                showChevron
            />
        </View>

        <View className="mt-7">
          <OrDivider />
        </View>

        <View className="mt-6">
          <EmailTab />
        </View>

        <View className="mt-2">

          <SectionLabel title="Full name" />
          <AuthInput
            placeholder="Enter your full name"
            icon="user"
            value={fullName}
            onChangeText={setFullName}
          />

          <SectionLabel title="Email Address" />
          <AuthInput
            placeholder="Enter your email"
            icon="mail"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />

          <SectionLabel title="Password" />
          <AuthInput
            placeholder="Create a password"
            icon="eye"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          <PasswordRules password={password} />

          <View className="mt-10">
            <PrimaryButton
                label="Create Account"
                onPress={() => isFormValid && router.push("/(auth)/create-profile")}
                style={{ opacity: isFormValid ? 1 : 0.5 }}
                disabled={!isFormValid}
            />
          </View>

        </View>

        <AuthFooter
            prompt="Already have an account?"
            linkLabel="Log In"
            onPress={() => router.push("/(auth)/login")}
        />

      </View>
    </ScrollView>
  );
}