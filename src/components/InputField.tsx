import { TextInput, TextInputProps, TouchableOpacity, View } from "react-native";
import { ChevronRightIcon } from "./Auth/icons";

interface InputFieldProps extends TextInputProps {
  onArrowPress?: () => void;
}

export default function InputField({ onArrowPress, ...props }: InputFieldProps) {
  return (
    <View className="flex-row items-center bg-[#191F18] border-2 border-[#6DA963] rounded-[9px] h-[61px] px-4">
      <TextInput
        className="flex-1 text-white text-base font-nata"
        placeholderTextColor="rgba(255,255,255,0.45)"
        
        {...props}
      />
      <TouchableOpacity onPress={onArrowPress} className="ml-2">
        <ChevronRightIcon size={20} color="#6DA963" />
      </TouchableOpacity>
    </View>
  );
}