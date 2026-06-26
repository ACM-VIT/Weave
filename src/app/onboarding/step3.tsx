import { router } from "expo-router";
import { Pressable, ScrollView, View, Text } from "react-native";

import ProgressBar from "@/components/onboarding/ProgressBar";
import PrimaryButton from "@/components/onboarding/PrimaryButton";
import InterestCard from "@/components/onboarding/InterestCard";
import LogoPlaceholder from "@/components/onboarding/LogoPlaceholder";
import StepHeader from "@/components/onboarding/StepHeader";

export default function Step3() {
  const completeOnboarding = () => {
    router.replace("/(tabs)/home");
  };

  return (
    <ScrollView
      style={{
        flex: 1,
        backgroundColor: "#0A0C09",
      }}
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 40,
      }}
      showsVerticalScrollIndicator={false}
    >
      <Text
        style={{
          color: "#F0F6EB",
          fontSize: 18,
          marginBottom: 12,
          textAlign: "right",
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
          color: "#8A8A8A",
          fontSize: 15,
          marginTop: 24,
          marginBottom: 14,
        }}
      >
        CHOOSE YOUR INTERESTS
      </Text>

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "space-between",
        }}
      >
        <InterestCard icon="⚙️" title="Open Source" selected />
        <InterestCard icon="✨" title="AI/ML" selected />

        <InterestCard icon="🌐" title="Web Development" selected />
        <InterestCard icon="📱" title="Mobile Dev" />

        <InterestCard icon="∞" title="DevOps" />
        <InterestCard icon="🛠️" title="UI/UX Design" />

        <InterestCard icon="🛡️" title="CyberSecurity" />
        <InterestCard icon="☁️" title="Cloud Computing" />

        <InterestCard icon="🎮" title="Gaming" />
      </View>

      <View style={{ marginTop: 20 }}>
        <PrimaryButton
          title="Finish"
          onPress={completeOnboarding}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={completeOnboarding}
        style={{ marginTop: 12, paddingVertical: 8 }}
      >
        <Text
          style={{
            color: "#8A8A8A",
            textAlign: "center",
            fontSize: 15,
          }}
        >
          Skip for now
        </Text>
      </Pressable>
    </ScrollView>
  );
}
