import { TextInput, View, TextInputProps } from "react-native";
import { UserIcon, MailIcon, EyeIcon } from "./icons";

interface Props extends TextInputProps {
  placeholder: string;
  secureTextEntry?: boolean;
  icon?: string;
}

export default function AuthInput({
  placeholder,
  secureTextEntry,
  icon,
  ...rest
}: Props) {
  return (
    <View className="h-[46px] border border-[#6DA963] rounded-xl bg-[#191F18] px-4 flex-row items-center">
      {icon === "user" && <View className="mr-3"><UserIcon /></View>}
      {icon === "mail" && <View className="mr-3"><MailIcon /></View>}
      {icon === "eye" && <View className="mr-3"><EyeIcon /></View>}
      
      <TextInput
        placeholder={placeholder}
        placeholderTextColor="#727272"
        secureTextEntry={secureTextEntry}
        className="font-nata text-white text-[13px] outline-none flex-1 h-full"
        {...rest}
      />
    </View>
  );
}