import { KeyboardForm } from '@/components/keyboard/keyboard-layout';
import { useState } from "react";
import { router } from "expo-router";
import {
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useOnboarding } from "../../store/OnboardingContext";

import PrimaryButton from "@/components/onboarding/PrimaryButton";
import ProgressBar from "@/components/onboarding/ProgressBar";
import TechChip from "@/components/onboarding/TechChip";
import LogoPlaceholder from "@/components/onboarding/LogoPlaceholder";

import { SUGGESTED_TECHS, getTechIcon } from "@/constants/onboarding";

const PREDEFINED_TECHS = SUGGESTED_TECHS.map(t => t.name);

export default function Step2() {
  const { data, updateData } = useOnboarding();

  const [selectedTechs, setSelectedTechs] = useState<string[]>(data.tech_stack ?? []);
  const [customTechs, setCustomTechs] = useState<string[]>([]);
  const [inputText, setInputText] = useState("");

  const handleAddTech = () => {
    const tech = inputText.trim();
    if (!tech) return;

    const allKnownTechs = [...PREDEFINED_TECHS, ...customTechs];
    const existing = allKnownTechs.find((t) => t.toLowerCase() === tech.toLowerCase());

    if (existing) {
      if (!selectedTechs.includes(existing)) {
        setSelectedTechs([...selectedTechs, existing]);
      }
    } else {
      setCustomTechs([...customTechs, tech]);
      setSelectedTechs([...selectedTechs, tech]);
    }
    setInputText("");
  };

  const toggleTech = (tech: string) => {
    setSelectedTechs((prev) =>
      prev.includes(tech) ? prev.filter((t) => t !== tech) : [...prev, tech]
    );
  };

  const handleContinue = () => {
    if (selectedTechs.length === 0) return;

    updateData({ tech_stack: selectedTechs });
    router.push("/onboarding/step3");
  };

  const suggestedTechs = [...PREDEFINED_TECHS, ...customTechs].filter(
    (t) => !selectedTechs.includes(t)
  );

  return (
    <SafeAreaView className="flex-1 bg-black">
      <KeyboardForm safeArea={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 10,
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
          2 / 3
        </Text>

        <ProgressBar step={2} totalSteps={3} />

        {/* Logo */}
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
            What tech stack
          </Text>

          <Text
            style={{
              color: "#63E08A",
              fontSize: 40,
              fontWeight: "700",
              textAlign: "center",
            }}
          >
            do you use?
          </Text>

          <Text
            style={{
              color: "rgba(235,235,245,0.6)",
              textAlign: "center",
              fontSize: 15,
              marginTop: 8,
            }}
          >
            Add the technologies you work with
          </Text>

          <Text
            style={{
              color: "rgba(235,235,245,0.6)",
              textAlign: "center",
              fontSize: 15,
            }}
          >
            or want to explore.
          </Text>
        </View>

        {/* Custom Tech Input */}
        <View
          style={{
            marginTop: 16,
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: "#1C1C1E",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.14)",
            borderRadius: 12,
            paddingHorizontal: 14,
          }}
        >
          <TextInput
            accessibilityLabel="Technology"
            returnKeyType="done"
            value={inputText}
            onChangeText={setInputText}
            onSubmitEditing={handleAddTech}
            placeholder="Add your own tech stack"
            placeholderTextColor="#A6A6AE"
            style={{
              flex: 1,
              paddingVertical: 14,
              paddingHorizontal: 8,
              color: "white",
            }}
          />
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add technology" onPress={handleAddTech} style={{ padding: 8, minWidth: 48, minHeight: 48, alignItems: "center" }}>
            <Text style={{ color: "#63E08A", fontSize: 24, fontWeight: "500" }}>
              +
            </Text>
          </TouchableOpacity>
        </View>

        {/* Selected */}
        {selectedTechs.length > 0 && (
          <>
            <Text
              style={{
                color: "rgba(235,235,245,0.6)",
                fontSize: 16,
                marginTop: 16,
                marginBottom: 10,
              }}
            >
              Your Selection
            </Text>

            <View className="flex-row flex-wrap">
              {selectedTechs.map((tech) => (
                <TechChip
                  key={tech}
                  title={tech}
                  image={getTechIcon(tech)}
                  selected
                  onPress={() => toggleTech(tech)}
                />
              ))}
            </View>
          </>
        )}

        {/* Suggested */}
        {suggestedTechs.length > 0 && (
          <>
            <Text
              style={{
                color: "rgba(235,235,245,0.6)",
                fontSize: 16,
                marginTop: 10,
                marginBottom: 10,
              }}
            >
              Suggested for you
            </Text>

            <View className="flex-row flex-wrap">
              {suggestedTechs.map((tech) => (
                <TechChip
                  key={tech}
                  title={tech}
                  image={getTechIcon(tech)}
                  selected={false}
                  onPress={() => toggleTech(tech)}
                />
              ))}
            </View>
          </>
        )}

        {selectedTechs.length === 0 ? (
          <Text style={{ color: "#FF453A", fontSize: 14, marginTop: 8, textAlign: "center" }}>
            Select at least 1 technology.
          </Text>
        ) : null}

        <View style={{ marginTop: selectedTechs.length === 0 ? 8 : 16 }}>
          <PrimaryButton
            title="Continue"
            onPress={handleContinue}
            disabled={selectedTechs.length === 0}
          />
        </View>

        </View>
      </KeyboardForm>
    </SafeAreaView>
  );
}
