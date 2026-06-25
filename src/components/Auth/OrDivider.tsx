import { Text, View } from "react-native";

export default function OrDivider() {
  return (
    <View className="flex-row items-center gap-3 my-2">
      <View className="flex-1 h-px bg-white opacity-20" />

      <Text
        className="text-white opacity-40 text-xs tracking-widest uppercase font-nata"
      >
        or
      </Text>

      <View className="flex-1 h-px bg-white opacity-20" />
    </View>
  );
}