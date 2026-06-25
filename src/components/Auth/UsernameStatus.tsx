import { View, Text } from "react-native";
import { Check } from "lucide-react-native";

export default function UsernameStatus() {
  return (
    <View className="flex-row items-center mt-4">
      <View className="w-4 h-4 rounded-full border border-[#6DA963] justify-center items-center bg-[#6DA963]">
        <Check size={10} color="#0A0C09" strokeWidth={3} />
      </View>

      <Text
        className="text-[#6DA963] ml-3 text-sm font-nata"
      >
        This username looks good!
      </Text>
    </View>
  );
}