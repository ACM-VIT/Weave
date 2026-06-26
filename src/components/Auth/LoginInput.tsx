import { TextInput, View } from "react-native";

interface Props {
  placeholder: string;
  secureTextEntry?: boolean;
}

export default function LoginInput({
  placeholder,
  secureTextEntry,
}: Props) {
  return (
    <View className="h-[60px] border-2 border-[#6DA963] rounded-[12px] bg-[#191F18] px-5 justify-center">
      <TextInput
        placeholder={placeholder}
        placeholderTextColor="#5F5F5F"
        secureTextEntry={secureTextEntry}
        className="text-white text-[14px] font-nata outline-none w-full h-full"
      />
    </View>
  );
}