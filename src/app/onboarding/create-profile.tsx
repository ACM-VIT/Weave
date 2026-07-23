import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useOnboarding } from "../../store/OnboardingContext";
import { useAuth } from "../../store/AuthContext";
import { isValidUsername, normalizeUsername, USERNAME_GUIDANCE } from "../../utils/username";

import PrimaryButton from "@/components/Auth/PrimaryButton";
import ProfileInput from "@/components/Auth/ProfileInput";
import ProfileTextArea from "@/components/Auth/ProfileTextArea";
import TermsFooter from "@/components/Auth/TermsFooter";

export default function CreateProfile() {
  const router = useRouter();
  const { updateData } = useOnboarding();
  const { user } = useAuth();
  
  const [username, setUsername] = useState(user?.username || "");
  const [bio, setBio] = useState("");

  const normalizedUsername = normalizeUsername(username);
  const isUsernameValid = isValidUsername(username);

  const handleCreateAccount = () => {
    if (isUsernameValid) {
      updateData({ 
        username: normalizedUsername,
        bio,
        full_name: user?.full_name || normalizedUsername,
      });
      router.push("/onboarding/step1");
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-[#000000]"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: 50 }}
    >
      <View className="px-8 pt-14 w-full" style={{ maxWidth: 450, alignSelf: 'center' }}>

        {/* Heading */}
        <View className="items-center mt-4">
          <Text
            
            className="text-white text-[32px] text-center font-nataBold"
          >
            Create your{" "}
            <Text className="text-white font-nataBold">
              Wea<Text className="text-[#63E08A]">v</Text>e
            </Text>
            {" "}
            <Text className="text-[#63E08A] font-nataBold">account</Text>
          </Text>

          <Text
            
            className="text-[rgba(235,235,245,0.6)] text-[14px] text-center mt-3 font-nata"
          >
            Let&apos;s set up your profile.
          </Text>
        </View>

        {/* Username */}
        <View className="mt-8">
          <ProfileInput
            title="Username"
            placeholder="Choose a username"
            value={username}
            onChangeText={setUsername}
          />

          {username.length > 0 && !isUsernameValid ? (
            <Text className="text-[#FF453A] text-[13px] font-nata mt-1 ml-1">
              {USERNAME_GUIDANCE}
            </Text>
          ) : null}
        </View>

        {/* Bio */}
        <View className="mt-4">
            <ProfileTextArea value={bio} onChangeText={setBio} />
        </View>

        {/* Create Account */}
        <View className="mt-8">
          <PrimaryButton
            label="Create Account"
            onPress={handleCreateAccount}
            disabled={!isUsernameValid}
          />
        </View>

        {/* Terms */}
        <TermsFooter />

      </View>
    </ScrollView>
  );
}
