import { router } from "expo-router";
import {
    ScrollView,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import PrimaryButton from "@/components/onboarding/PrimaryButton";
import ProgressBar from "@/components/onboarding/ProgressBar";
import SkillCard from "@/components/onboarding/SkillCard";

export default function Step1() {
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
        {/* Step */}
        <Text
          style={{
            color: "#F0F6EB",
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
          <View
            style={{
              width: 120,
              height: 120,
              borderRadius: 60,
              backgroundColor: "#10391D",
            }}
          />
        </View>

        {/* Heading */}
        <View style={{ alignItems: "center" }}>
          <Text
            style={{
              color: "#F0F6EB",
              fontSize: 40,
              fontWeight: "700",
              textAlign: "center",
            }}
          >
            What are your
          </Text>

          <Text
            style={{
              color: "#6DA963",
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
              color: "#8A8A8A",
              textAlign: "center",
              fontSize: 15,
              lineHeight: 22,
            }}
          >
            Select the skills you have so we can
          </Text>

          <Text
            style={{
              color: "#8A8A8A",
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
            color: "#8A8A8A",
            fontSize: 13,
            letterSpacing: 1,
            marginTop: 28,
            marginBottom: 14,
          }}
        >
          POPULAR SKILLS
        </Text>

        {/* Skills */}
        <View className="flex-row flex-wrap justify-between gap-y-4">
          <SkillCard icon="JS" title="JavaScript" selected />
          <SkillCard icon="TS" title="TypeScript" selected />
          <SkillCard icon="Py" title="Python" selected />
          <SkillCard icon="⚛" title="React" selected />
          <SkillCard icon="☕" title="Java" />
          <SkillCard icon="Go" title="Go" />
        </View>

        {/* Show More */}
        <TouchableOpacity
          style={{
            alignItems: "center",
            marginTop: 12,
          }}
        >
          <Text
            style={{
              color: "#6DA963",
              fontSize: 22,
              fontWeight: "600",
            }}
          >
            + Show more
          </Text>
        </TouchableOpacity>

        {/* Continue */}
        <View style={{ marginTop: 16 }}>
          <PrimaryButton
  title="Continue"
  onPress={() => router.push("/onboarding/step2")}
/>
        </View>

        {/* Skip */}
        <TouchableOpacity
          style={{
            alignItems: "center",
            marginTop: 12,
          }}
        >
          <Text
            style={{
              color: "#8A8A8A",
              fontSize: 18,
            }}
          >
            Skip for now
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}