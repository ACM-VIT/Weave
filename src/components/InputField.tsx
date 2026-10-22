import { TextInput, TextInputProps, TouchableOpacity, View } from "react-native";
import { ChevronRightIcon } from "./Auth/icons";

interface InputFieldProps extends TextInputProps {
  onArrowPress?: () => void;
}

export default function InputField({ onArrowPress, ...props }: InputFieldProps) {
  return (
    <View className="flex-row items-center bg-[#191F18] border-2 border-[#8EFF7A] rounded-[9px] h-[61px] px-4">
      <TextInput
        accessibilityLabel={props.accessibilityLabel ?? props.placeholder ?? "Text"}
        className="flex-1 text-white text-base font-nata"
        placeholderTextColor="#A6A6AE"
        
        {...props}
      />
      {onArrowPress ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Continue" onPress={onArrowPress} style={{ minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center" }} className="ml-2">
        <ChevronRightIcon size={20} color="#8EFF7A" />
      </TouchableOpacity> : null}
    </View>
  );
}