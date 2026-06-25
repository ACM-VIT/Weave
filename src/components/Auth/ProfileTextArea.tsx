import { View, Text, TextInput } from "react-native";

export default function ProfileTextArea() {
  return (
    <View>
      <Text
        className="text-white text-[15px] mb-3 font-nata"
      >
        Bio (optional)
      </Text>

      <TextInput
        multiline
        numberOfLines={2}
        maxLength={60}
        textAlignVertical="top"
        placeholder="Tell us about yourself!"
        placeholderTextColor="#666"
        className="bg-[#191F18]
 border border-[#6DA963]
 rounded-xl
 h-[90px]
 px-5
 pt-4
 text-white
 text-[15px]
 font-nata outline-none"
      />
    </View>
  );
}