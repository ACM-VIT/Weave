import { View, Text } from "react-native";

export default function TermsFooter() {
  return (
    <View className="items-center mt-10">
      <Text
        className="text-[#7B7B7B] text-xs text-center font-nata"
      >
        By signing up, you agree to our
      </Text>

      <Text
        className="text-[#6DA963] text-xs mt-1 font-nata"
      >
        Terms of Service and Privacy Policy.
      </Text>
    </View>
  );
}