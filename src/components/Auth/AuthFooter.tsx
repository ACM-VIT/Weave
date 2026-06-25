import { Text, TouchableOpacity, View } from "react-native";

interface AuthFooterProps {
  prompt: string;
  linkLabel: string;
  onPress: () => void;
}

export default function AuthFooter({
  prompt,
  linkLabel,
  onPress,
}: AuthFooterProps) {
  return (
    <View className="flex-row items-center justify-center gap-1 mt-6">
      <Text className="font-nata text-white opacity-50 text-[16px]">
        {prompt}
      </Text>

      <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
        <Text className="font-nataSemiBold text-[#6DA963] text-[16px]">
          {linkLabel}
        </Text>
      </TouchableOpacity>
    </View>
  );
}