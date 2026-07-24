import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useOnboarding } from "../../store/OnboardingContext";
import { useAuth } from "../../store/AuthContext";
import { isValidDateOfBirth } from "../../utils/date-of-birth";
import { isValidUsername, normalizeUsername, USERNAME_GUIDANCE } from "../../utils/username";

import DateOfBirthField from "@/components/Auth/date-of-birth-field";
import PrimaryButton from "@/components/Auth/PrimaryButton";
import ProfileInput from "@/components/Auth/ProfileInput";
import ProfileTextArea from "@/components/Auth/ProfileTextArea";
import SectionLabel from "@/components/Auth/SectionLabel";
import TermsFooter from "@/components/Auth/TermsFooter";

export default function CreateProfile() {
  const router = useRouter();
  const { updateData } = useOnboarding();
  const { user } = useAuth();
  
  const [fullName, setFullName] = useState(user?.full_name || "");
  const [username, setUsername] = useState(user?.username || "");
  const [dateOfBirth, setDateOfBirth] = useState(user?.date_of_birth || "");
  const [bio, setBio] = useState("");

  const normalizedUsername = normalizeUsername(username);
  const isFullNameValid = fullName.trim().length > 0;
  const isUsernameValid = isValidUsername(username);
  const isDateOfBirthValid = isValidDateOfBirth(dateOfBirth);
  const isProfileValid = isFullNameValid && isUsernameValid && isDateOfBirthValid;

  const handleCreateAccount = () => {
    if (isProfileValid) {
      updateData({ 
        username: normalizedUsername,
        full_name: fullName.trim(),
        date_of_birth: dateOfBirth,
        bio,
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

        {/* Profile details */}
        <View className="mt-8">
          <ProfileInput
            title="Full Name"
            placeholder="Enter your full name"
            value={fullName}
            onChangeText={setFullName}
          />

          <View className="mt-4">
            <ProfileInput
              title="Username"
              placeholder="Choose a username"
              value={username}
              onChangeText={setUsername}
            />
          </View>

          {username.length > 0 && !isUsernameValid ? (
            <Text className="text-[#FF453A] text-[13px] font-nata mt-1 ml-1">
              {USERNAME_GUIDANCE}
            </Text>
          ) : null}

          <View className="mt-4">
            <SectionLabel title="Date of Birth" />
            <DateOfBirthField value={dateOfBirth} onChange={setDateOfBirth} />
            {dateOfBirth.length > 0 && !isDateOfBirthValid ? (
              <Text className="text-[#FF453A] text-[13px] font-nata mt-1 ml-1">
                Select a valid date of birth.
              </Text>
            ) : null}
          </View>
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
            disabled={!isProfileValid}
          />
        </View>

        {/* Terms */}
        <TermsFooter />

      </View>
    </ScrollView>
  );
}
