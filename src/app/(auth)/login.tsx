import { Href, useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { useAuth } from "../../store/AuthContext";
import { login } from "../../api/auth";
import { useOAuth } from "../../hooks/useOAuth";

import AuthFooter from "@/components/Auth/AuthFooter";
import BrandWord from "@/components/Auth/BrandWord";
import LogoCircle from "@/components/Auth/LogoCircle";
import OrDivider from "@/components/Auth/OrDivider";
import PrimaryButton from "@/components/Auth/PrimaryButton";
import SocialButton from "@/components/Auth/SocialButton";

import LoginInput from "@/components/Auth/LoginInput";
import ForgotPassword from "@/components/Auth/ForgotPassword";

import {
    GithubIcon,
    GoogleIcon,
} from "@/components/Auth/icons";

export default function LoginScreen() {
  const router = useRouter();
  const { setSession } = useAuth();
  const { signInWithProvider, isLoading: oauthLoading, error: oauthError } = useOAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const isFormValid = email.trim().length > 0 && password.length > 0 && !isLoading;

  const handleLogin = async () => {
    if (!isFormValid) return;
    setIsLoading(true);
    setErrorMsg("");
    try {
      const data = await login(email, password);
      await setSession(data);
      // _layout.tsx will handle redirection
    } catch (err: any) {
      setErrorMsg(err.message || 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
    >
      <ScrollView
        className="flex-1 bg-[#000000]"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: 24, paddingBottom: 40, flexGrow: 1, justifyContent: 'center' }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="px-8 w-full" style={{ maxWidth: 450, alignSelf: 'center' }}>

          {/* Logo */}
          <View className="items-center">
            <LogoCircle />
          </View>

          {/* Heading */}
          <View className="items-center mt-8">
            <Text

              className="text-white text-[30px] text-center font-nataBold"
            >
              Welcome to{' '}
              <BrandWord />
            </Text>

            <Text
              
              className="text-[rgba(235,235,245,0.6)] text-[14px] mt-3 text-center font-nata"
            >
              Glad to see you again.
            </Text>
          </View>

          {/* Social buttons */}
          <View className="mt-10 gap-y-5">
            <SocialButton
              label={oauthLoading ? "Opening..." : "Continue with GitHub"}
              icon={
                <GithubIcon
                  color={oauthLoading ? "rgba(235,235,245,0.35)" : "#FFFFFF"}
                />
              }
              showChevron
              disabled={oauthLoading}
              onPress={() => signInWithProvider('github')}
            />

            <SocialButton
              label={oauthLoading ? "Opening..." : "Continue with Google"}
              icon={<GoogleIcon />}
              showChevron
              disabled={oauthLoading}
              onPress={() => signInWithProvider('google')}
            />
          </View>

          {oauthError ? (
            <Text className="text-[#FF453A] text-[13px] font-nata mt-3 text-center">
              {oauthError}
            </Text>
          ) : null}

          {/* Divider */}
          <View className="mt-7">
            <OrDivider />
          </View>

          {/* Email */}
          <Text

            className="text-white text-[15px] mt-8 mb-3 font-nata"
          >
            Email Address
          </Text>

          <LoginInput
            placeholder="Enter your email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />

          {/* Password */}
          <Text

            className="text-white text-[15px] mt-7 mb-3 font-nata"
          >
            Password
          </Text>

          <LoginInput
            placeholder="Enter your password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          <View className="items-end mt-5">
            <ForgotPassword onPress={() => router.push('/(auth)/forgot-password' as Href)} />
          </View>

          {errorMsg ? (
            <Text className="text-[#FF453A] text-[13px] font-nata mt-4 text-center">
              {errorMsg}
            </Text>
          ) : null}

          {/* Button */}
          <View className="mt-8">
            <PrimaryButton
              label={isLoading ? "Logging In..." : "Log In"}
              onPress={handleLogin}
              disabled={!isFormValid}
            />
          </View>

          {/* Footer */}
          <AuthFooter
            prompt="Don't have an account?"
            linkLabel="Sign up"
            onPress={() => router.push("/(auth)/sign-up")}
          />

        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
