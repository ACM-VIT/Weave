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
    <View className="h-[46px] border border-[rgba(255,255,255,0.14)] rounded-xl bg-[#1C1C1E] px-4 flex-row items-center">
      {icon === "user" && <View className="mr-3"><UserIcon /></View>}
      {icon === "mail" && <View className="mr-3"><MailIcon /></View>}
      {icon === "eye" && <View className="mr-3"><EyeIcon /></View>}
      
      <TextInput
        accessibilityLabel={placeholder}
        placeholder={placeholder}
        placeholderTextColor="#A6A6AE"
        autoCapitalize={secureTextEntry ? "none" : undefined}
        autoCorrect={secureTextEntry ? false : undefined}
        autoComplete={secureTextEntry ? "new-password" : undefined}
        secureTextEntry={secureTextEntry}
        className="font-nata text-white text-[13px] outline-none flex-1 h-full"
        {...rest}
      />
    </View>
  );
}
