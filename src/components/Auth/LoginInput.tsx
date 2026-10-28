import { TextInput, TextInputProps, View } from "react-native";
import { useState } from "react";

interface Props extends TextInputProps {
  placeholder: string;
  secureTextEntry?: boolean;
}

export default function LoginInput({
  placeholder,
  secureTextEntry,
  onFocus,
  onBlur,
  ...rest
}: Props) {
  const [focused, setFocused] = useState(false);
  return (
    <View className="h-[60px] border-2 border-[rgba(255,255,255,0.14)] rounded-[12px] bg-[#1C1C1E] px-5 justify-center"
      style={focused ? { borderColor: '#63E08A' } : undefined}>
      <TextInput
        accessibilityLabel={placeholder}
        autoComplete={secureTextEntry ? "current-password" : undefined}
        placeholder={placeholder}
        placeholderTextColor="#A6A6AE"
        autoCapitalize={secureTextEntry ? "none" : undefined}
        autoCorrect={secureTextEntry ? false : undefined}
        secureTextEntry={secureTextEntry}
        className="text-white text-[14px] font-nata w-full h-full"
        {...rest}
        onFocus={(event) => { setFocused(true); onFocus?.(event); }}
        onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      />
    </View>
  );
}
