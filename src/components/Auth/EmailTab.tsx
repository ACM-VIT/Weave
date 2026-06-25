import { Text, View } from "react-native";
import { MailIcon } from "./icons";

export default function EmailTab() {
  return (
    <View className="h-[46px] border border-[#6DA963] rounded-xl bg-[#191F18] flex-row justify-center items-center">
      <MailIcon size={18} />

      <Text
        className="text-[#6DA963] ml-2 text-[13px] font-nata"
      >
        Email
      </Text>
    </View>
  );
}