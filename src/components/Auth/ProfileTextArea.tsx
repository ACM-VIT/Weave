import { View, Text, TextInput, TextInputProps } from "react-native";

interface Props extends TextInputProps {
  value?: string;
  onChangeText?: (text: string) => void;
}

export default function ProfileTextArea({ value, onChangeText, ...rest }: Props) {
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
        textAlignVertical="top"
        placeholder="Tell us about yourself!"
        placeholderTextColor="rgba(235,235,245,0.3)"
        value={value}
        onChangeText={onChangeText}
        maxLength={2000}
        className="bg-[#1C1C1E]
 border border-[rgba(255,255,255,0.14)]
 rounded-xl
 h-[90px]
 px-5
 pt-4
 text-white
 text-[15px]
 font-nata outline-none"
        {...rest}
      />
      <Text className="mt-1 text-right text-[12px] text-[rgba(235,235,245,0.45)] font-nata">
        {value?.length ?? 0} / 2000 characters
      </Text>
    </View>
  );
}
