import { useState } from "react";
import { router } from "expo-router";
import {
    ScrollView,
    Text,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import PrimaryButton from "@/components/onboarding/PrimaryButton";
import ProgressBar from "@/components/onboarding/ProgressBar";
import SkillCard from "@/components/onboarding/SkillCard";
import LogoPlaceholder from "@/components/onboarding/LogoPlaceholder";
import { SKILL_CATEGORIES } from "@/constants/onboarding";
import { useOnboarding } from "../../store/OnboardingContext";

export default function Step1() {
  const { data, updateData } = useOnboarding();
  const [selectedCategories, setSelectedCategories] = useState<string[]>(data.skills ?? []);

  const toggleCategory = (id: string) => {
    setSelectedCategories((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const handleContinue = () => {
    if (selectedCategories.length >= 2) {
      updateData({ skills: selectedCategories });
      router.push("/onboarding/step2");
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-black">
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 20,
          paddingBottom: 40,
        }}
      >
        <View style={{ maxWidth: 450, width: "100%", alignSelf: "center" }}>
          {/* Step */}
        <Text
          style={{
            color: "#FFFFFF",
            fontSize: 18,
            marginBottom: 12,
          }}
        >
          1 / 3
        </Text>

        <ProgressBar
          step={1}
          totalSteps={3}
        />

        {/* Logo Placeholder */}
        <View
          style={{
            alignItems: "center",
            marginTop: 24,
            marginBottom: 24,
          }}
        >
          <LogoPlaceholder size={120} />
        </View>

        {/* Heading */}
        <View style={{ alignItems: "center" }}>
          <Text
            style={{
              color: "#FFFFFF",
              fontSize: 40,
              fontWeight: "700",
              textAlign: "center",
            }}
          >
            What are your
          </Text>

          <Text
            style={{
              color: "#63E08A",
              fontSize: 38,
              fontWeight: "700",
              textAlign: "center",
              marginBottom: 10,
            }}
          >
            skills?
          </Text>

          <Text
            style={{
              color: "rgba(235,235,245,0.6)",
              textAlign: "center",
              fontSize: 15,
              lineHeight: 22,
            }}
          >
            Select the skills you have so we can
          </Text>

          <Text
            style={{
              color: "rgba(235,235,245,0.6)",
              textAlign: "center",
              fontSize: 15,
              lineHeight: 22,
            }}
          >
            personalize your experience.
          </Text>
        </View>

        {/* Section Title */}
        <Text
          style={{
            color: "rgba(235,235,245,0.6)",
            fontSize: 13,
            letterSpacing: 1,
            marginTop: 28,
            marginBottom: 14,
          }}
        >
          CATEGORIES
        </Text>

        {/* Skills */}
        <View className="flex-row flex-wrap justify-between gap-y-4">
          {SKILL_CATEGORIES.map((category) => (
            <SkillCard
              key={category.id}
              image={category.icon}
              title={category.title}
              selected={selectedCategories.includes(category.id)}
              onPress={() => toggleCategory(category.id)}
            />
          ))}
        </View>

        {selectedCategories.length < 2 && (
          <Text style={{ color: "#FF453A", fontSize: 14, marginTop: 16, textAlign: "center" }}>
            Select at least 2 categories.
          </Text>
        )}

        {/* Continue */}
        <View style={{ marginTop: selectedCategories.length < 2 ? 8 : 24 }}>
          <PrimaryButton
            title="Continue"
            onPress={handleContinue}
            disabled={selectedCategories.length < 2}
          />
        </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
