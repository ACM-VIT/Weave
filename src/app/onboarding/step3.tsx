import { KeyboardForm } from '@/components/keyboard/keyboard-layout';
import { useState } from "react";
import {  View, Text } from "react-native";
import { useAuth } from "../../store/AuthContext";
import { useOnboarding } from "../../store/OnboardingContext";

import ProgressBar from "@/components/onboarding/ProgressBar";
import PrimaryButton from "@/components/onboarding/PrimaryButton";
import TechChip from "@/components/onboarding/TechChip";
import LogoPlaceholder from "@/components/onboarding/LogoPlaceholder";
import StepHeader from "@/components/onboarding/StepHeader";
import { INTEREST_CATEGORIES } from "@/constants/onboarding";

export default function Step3() {
  const { data: onboardingData, updateData } = useOnboarding();
  const selectedCategoryIds = onboardingData.skills ?? [];
  const selectedInterests = onboardingData.interests ?? [];
  const { completeOnboarding: saveOnboarding, reconcileOnboarding, onboardingSave } = useAuth();
  const needsConfirmation = onboardingSave.status === 'unknown' || onboardingSave.status === 'checking';
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const toggleInterest = (keyword: string) => {
    updateData((previous) => {
      const interests = previous.interests ?? [];
      return { interests: interests.includes(keyword)
        ? interests.filter((value) => value !== keyword)
        : [...interests, keyword] };
    });
  };

  const completeOnboarding = async () => {
    if (selectedInterests.length >= 5) {
      setIsSubmitting(true);
      setErrorMsg("");
      try {
        await saveOnboarding({
          ...onboardingData,
          username: onboardingData.username || "",
          full_name: onboardingData.full_name || "",
          date_of_birth: onboardingData.date_of_birth || "",
          interests: selectedInterests,
          skills: selectedCategoryIds,
        });
        
        // The _layout.tsx will now automatically redirect to (tabs)
      } catch (err: any) {
        setErrorMsg(err.message || 'Failed to save profile');
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const checkSaveStatus = async () => {
    setErrorMsg('');
    try { await reconcileOnboarding(); }
    catch (error) { setErrorMsg(error instanceof Error ? error.message : 'Could not check save status. Try again.'); }
  };

  return (
    <KeyboardForm
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

      {onboardingSave.message || errorMsg ? (
        <Text accessibilityLiveRegion="polite" style={{ color: "#FF453A", fontSize: 14, marginTop: 4, textAlign: "center" }}>
          {onboardingSave.message || errorMsg}
        </Text>
      ) : null}

      {needsConfirmation ? <View style={{ marginTop: 12 }}>
        <PrimaryButton title={onboardingSave.status === 'checking' ? 'Checking save...' : 'Check save status'}
          onPress={checkSaveStatus} disabled={onboardingSave.status === 'checking' || isSubmitting} />
      </View> : null}

      <View style={{ marginTop: selectedInterests.length < 5 ? 8 : 20 }}>
        <PrimaryButton
          title={isSubmitting ? "Saving..." : "Finish"}
          onPress={completeOnboarding}
          disabled={selectedInterests.length < 5 || isSubmitting || onboardingSave.status !== 'idle'}
        />
      </View>

    </View>
    </KeyboardForm>
  );
}
