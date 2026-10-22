import { TextInput, TextInputProps, View } from "react-native";

interface Props extends TextInputProps {
  placeholder: string;
  secureTextEntry?: boolean;
}

export default function LoginInput({
  placeholder,
  secureTextEntry,
  ...rest
}: Props) {
  return (
    <View className="h-[60px] border-2 border-[rgba(255,255,255,0.14)] rounded-[12px] bg-[#1C1C1E] px-5 justify-center">
      <TextInput
        accessibilityLabel={placeholder}
        autoComplete={secureTextEntry ? "current-password" : undefined}
        placeholder={placeholder}
        placeholderTextColor="#A6A6AE"
        autoCapitalize={secureTextEntry ? "none" : undefined}
        autoCorrect={secureTextEntry ? false : undefined}
        secureTextEntry={secureTextEntry}
        className="text-white text-[14px] font-nata outline-none w-full h-full"
        {...rest}
      />
    </View>
  );
}
