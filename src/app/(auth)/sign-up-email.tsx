import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    Text,
    View,
} from "react-native";
import { useAuth } from "../../store/AuthContext";
import { register } from "../../api/auth";
import { useOAuth } from "../../hooks/useOAuth";

import AuthFooter from "@/components/Auth/AuthFooter";
import AuthInput from "@/components/Auth/AuthInput";
import BrandWord from "@/components/Auth/BrandWord";
import EmailTab from "@/components/Auth/EmailTab";
import { GithubIcon, GoogleIcon } from "@/components/Auth/icons";
import LogoCircle from "@/components/Auth/LogoCircle";
import OrDivider from "@/components/Auth/OrDivider";
import PasswordRules from "@/components/Auth/PasswordRules";
import PrimaryButton from "@/components/Auth/PrimaryButton";
import SectionLabel from "@/components/Auth/SectionLabel";
import SocialButton from "@/components/Auth/SocialButton";
import { isValidUsername, normalizeUsername, USERNAME_GUIDANCE } from "@/utils/username";

export default function SignUpEmail() {
  const router = useRouter();
  const scrollViewRef = useRef<ScrollView>(null);
  const { signInWithProvider, isLoading: oauthLoading, error: oauthError } = useOAuth();

  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const { setSession } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const hasMinLength = password.length >= 8;
  const hasNumber = /\d/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const isPasswordValid = hasMinLength && hasNumber && hasUppercase;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isEmailValid = emailRegex.test(email);
  const normalizedUsername = normalizeUsername(username);
  const isUsernameValid = isValidUsername(username);

  const isFormValid = fullName.trim().length > 0 && isUsernameValid && isEmailValid && isPasswordValid && !isLoading;

  useEffect(() => {
    // Auto-scroll to bottom slowly on mount
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 500);
  }, []);

  const handleRegister = async () => {
    if (!isFormValid) return;
    setIsLoading(true);
    setErrorMsg("");
    try {
      const data = await register(email, password, fullName, normalizedUsername);
      await setSession(data.accessToken, data.user);
      // _layout.tsx will automatically redirect to onboarding
    } catch (err: any) {
      setErrorMsg(err.message || 'Registration failed');
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
        ref={scrollViewRef}
        className="flex-1 bg-[#000000]"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40, flexGrow: 1, justifyContent: 'center' }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="px-8 pt-14 w-full" style={{ maxWidth: 450, alignSelf: 'center' }}>

          <View className="items-center">
              <LogoCircle />
          </View>

          <View className="mt-8 items-center">
            <Text className="font-nataBold text-white text-[28px] text-center">
              Join
            </Text>

            <BrandWord className="font-nataBold text-[28px] text-center" />

            <Text className="font-nata text-[rgba(235,235,245,0.6)] text-center mt-4 text-[13px] leading-5">
              Join repositories and connect{"\n"}
              with developers around the world.
            </Text>
          </View>

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

          <View className="mt-7">
            <OrDivider />
          </View>

          <View className="mt-6">
            <EmailTab />
          </View>

          <View className="mt-2">

            <SectionLabel title="Name" />
            <AuthInput
              placeholder="Enter your name"
              icon="user"
              value={fullName}
              onChangeText={setFullName}
            />

            <SectionLabel title="Username" />
            <AuthInput
              placeholder="Choose your username"
              icon="user"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
            />
            {username.length > 0 && !isUsernameValid ? (
              <Text className="text-[#FF453A] text-[13px] font-nata mt-1 ml-1">
                {USERNAME_GUIDANCE}
              </Text>
            ) : null}

            <SectionLabel title="Email Address" />
            <AuthInput
              placeholder="Enter your email"
              icon="mail"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            {email.trim().length > 0 && !isEmailValid && (
              <Text className="text-[#FF453A] text-[13px] font-nata mt-1 ml-1">
                Please enter a valid email address.
              </Text>
            )}

            <SectionLabel title="Password" />
            <AuthInput
              placeholder="Create a password"
              icon="eye"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />

            <PasswordRules password={password} />

            {errorMsg ? (
              <Text className="text-[#FF453A] text-[13px] font-nata mt-2 text-center">
                {errorMsg}
              </Text>
            ) : null}

            <View className="mt-10">
              <PrimaryButton
                label={isLoading ? "Creating..." : "Create Account"}
                onPress={handleRegister}
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
    </KeyboardAvoidingView>
  );
}
