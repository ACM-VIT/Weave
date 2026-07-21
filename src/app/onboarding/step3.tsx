import { useState } from "react";
import { ScrollView, View, Text } from "react-native";
import { useAuth } from "../../store/AuthContext";
import { useOnboarding } from "../../store/OnboardingContext";
import * as SecureStore from '../../utils/storage';
import { setupOnboarding } from "../../api/onboarding";

import ProgressBar from "@/components/onboarding/ProgressBar";
import PrimaryButton from "@/components/onboarding/PrimaryButton";
import TechChip from "@/components/onboarding/TechChip";
import LogoPlaceholder from "@/components/onboarding/LogoPlaceholder";
import StepHeader from "@/components/onboarding/StepHeader";
import { INTEREST_CATEGORIES } from "@/constants/onboarding";

export default function Step3() {
  const { data: onboardingData } = useOnboarding();
  const selectedCategoryIds = onboardingData.skills ?? [];
  const [selectedInterests, setSelectedInterests] = useState<string[]>(onboardingData.interests ?? []);
  const { user, checkOnboardingStatus, completeOnboardingPreview } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const toggleInterest = (keyword: string) => {
    setSelectedInterests((prev) =>
      prev.includes(keyword)
        ? prev.filter((k) => k !== keyword)
        : [...prev, keyword]
    );
  };

  const completeOnboarding = async () => {
    if (selectedInterests.length >= 5) {
      setIsSubmitting(true);
      setErrorMsg("");
      try {
        if (user?.isPreview) {
          completeOnboardingPreview();
          return;
        }

        const token = await SecureStore.getItemAsync('access_token');
        if (!token) throw new Error("No access token found");
        
        await setupOnboarding(token, {
          ...onboardingData,
          username: onboardingData.username || "",
          full_name: onboardingData.full_name || "",
          interests: selectedInterests,
          skills: selectedCategoryIds,
        });
        
        await checkOnboardingStatus();
        // The _layout.tsx will now automatically redirect to (tabs)
      } catch (err: any) {
        setErrorMsg(err.message || 'Failed to save profile');
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  return (
    <ScrollView
      style={{
        flex: 1,
        backgroundColor: "#000000",
      }}
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 40,
      }}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ maxWidth: 450, width: "100%", alignSelf: "center" }}>
        <Text
        style={{
          color: "#FFFFFF",
          fontSize: 18,
          marginBottom: 12,
        }}
      >
        3 / 3
      </Text>

      <ProgressBar step={3} totalSteps={3} />

      <View
        style={{
          alignItems: "center",
          marginTop: 24,
        }}
      >
        <LogoPlaceholder />
      </View>

      <StepHeader
        titleWhite="What are your"
        titleGreen="interests?"
        description="Tell us what you're passionate about so we can connect you with the right people."
      />

      <Text
        style={{
          color: "rgba(235,235,245,0.6)",
          fontSize: 15,
          marginTop: 24,
          marginBottom: 14,
        }}
      >
        CHOOSE YOUR INTERESTS
      </Text>

      {INTEREST_CATEGORIES.filter((c) => selectedCategoryIds.includes(c.id)).map((category) => {
        if (!category.interests || category.interests.length === 0) return null;

        return (
          <View key={category.id} style={{ marginBottom: 24 }}>
            <Text
              style={{
                color: "#FFFFFF",
                fontSize: 16,
                fontWeight: "600",
                marginBottom: 12,
              }}
            >
              {category.title}
            </Text>
            <View className="flex-row flex-wrap">
              {category.interests.map((interest) => (
                <TechChip
                  key={interest.id}
                  title={interest.name}
                  image={interest.icon}
                  selected={selectedInterests.includes(interest.id)}
                  onPress={() => toggleInterest(interest.id)}
                />
              ))}
            </View>
          </View>
        );
      })}

      {selectedInterests.length < 5 && (
        <Text style={{ color: "#FF453A", fontSize: 14, marginTop: 4, textAlign: "center" }}>
          Select at least 5 interests.
        </Text>
      )}

      {errorMsg ? (
        <Text style={{ color: "#FF453A", fontSize: 14, marginTop: 4, textAlign: "center" }}>
          {errorMsg}
        </Text>
      ) : null}

      <View style={{ marginTop: selectedInterests.length < 5 ? 8 : 20 }}>
        <PrimaryButton
          title={isSubmitting ? "Saving..." : "Finish"}
          onPress={completeOnboarding}
          disabled={selectedInterests.length < 5 || isSubmitting}
        />
      </View>

    </View>
    </ScrollView>
  );
}
