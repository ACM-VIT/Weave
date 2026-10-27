import { passwordPolicyError } from '@/utils/password-policy';
import { KeyboardForm } from '@/components/keyboard/keyboard-layout';
import { useRouter } from "expo-router";
import { useState } from "react";
import {
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
import DateOfBirthField from "@/components/Auth/date-of-birth-field";
import { isValidDateOfBirth } from "@/utils/date-of-birth";
import { isValidUsername, normalizeUsername, USERNAME_GUIDANCE } from "@/utils/username";

export default function SignUpEmail() {
  const router = useRouter();
  const { signInWithProvider, isLoading: oauthLoading, error: oauthError } = useOAuth();

  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");

  const { setSession } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const passwordError = passwordPolicyError(password);
  const isPasswordValid = passwordError === null;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isEmailValid = emailRegex.test(email);
  const normalizedUsername = normalizeUsername(username);
  const isUsernameValid = isValidUsername(username);
  const isDateOfBirthValid = isValidDateOfBirth(dateOfBirth);

  const isFormValid = fullName.trim().length > 0
    && isUsernameValid
    && isDateOfBirthValid
    && isEmailValid
    && isPasswordValid
    && !isLoading;

  const getValidationMessage = () => {
    if (!fullName.trim()) return 'Enter your name.';
    if (!isUsernameValid) return USERNAME_GUIDANCE;
    if (!isDateOfBirthValid) return 'Select your date of birth.';
    if (!isEmailValid) return 'Enter a valid email address.';
    if (passwordError) return passwordError;
    return '';
  };

  const handleRegister = async () => {
    if (!isFormValid) {
      const validationMessage = getValidationMessage();
      setErrorMsg(validationMessage);
      return;
    }
    setIsLoading(true);
    setErrorMsg("");
    try {
      const data = await register(email, password, fullName, normalizedUsername, dateOfBirth);
      await setSession(data);
      // _layout.tsx will automatically redirect to onboarding
    } catch (err: any) {
      setErrorMsg(err.message || 'Registration failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOAuth = (provider: 'github' | 'google') => {
    void signInWithProvider(provider, 'signup');
  };

  return (
      <KeyboardForm
        className="flex-1 bg-[#000000]"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="px-8 pt-6 w-full" style={{ maxWidth: 450, alignSelf: 'center' }}>

          <View className="flex-row items-center gap-4">
            <LogoCircle size={56} />
            <View>
              <Text className="font-nata text-[13px] text-[#8A898F]">Join</Text>
              <BrandWord className="font-nataBold text-[28px]" />
            </View>
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

            <SectionLabel title="Date of Birth" />
            <DateOfBirthField value={dateOfBirth} onChange={setDateOfBirth} />
            {dateOfBirth.length > 0 && !isDateOfBirthValid ? (
              <Text className="text-[#FF453A] text-[13px] font-nata mt-1 ml-1">
                Select a valid date of birth.
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
                disabled={isLoading}
              />
            </View>

          </View>

          <View className="mt-7">
            <OrDivider />
          </View>

          <View className="mt-6 gap-y-5">
              <SocialButton
                  label={oauthLoading ? "Opening..." : "Continue with GitHub"}
                  icon={
                    <GithubIcon
                      color={oauthLoading ? "rgba(235,235,245,0.35)" : "#FFFFFF"}
                    />
                  }
                  showChevron
                  disabled={oauthLoading}
                  onPress={() => handleOAuth('github')}
              />

              <SocialButton
                  label={oauthLoading ? "Opening..." : "Continue with Google"}
                  icon={<GoogleIcon />}
                  showChevron
                  disabled={oauthLoading}
                  onPress={() => handleOAuth('google')}
              />
          </View>

          {oauthError ? (
            <Text className="text-[#FF453A] text-[13px] font-nata mt-3 text-center">
              {oauthError}
            </Text>
          ) : null}

          <AuthFooter
              prompt="Already have an account?"
              linkLabel="Log In"
              onPress={() => router.push("/(auth)/login")}
          />

        </View>
      </KeyboardForm>
  );
}
