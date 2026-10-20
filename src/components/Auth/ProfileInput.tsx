import { Text, TextInput, View, TextInputProps } from "react-native";

interface ProfileInputProps extends TextInputProps {
  title: string;
  placeholder: string;
}

export default function ProfileInput({
  title,
  placeholder,
  ...rest
}: ProfileInputProps) {
  return (
    <View>
      <Text
        className="text-white text-[15px] mb-3 font-nata"
      >
        {title}
      </Text>

      <View
        className="h-[56px]
        bg-[#1C1C1E]
        border border-[rgba(255,255,255,0.14)]
        rounded-xl
        px-5
        justify-center"
      >
        <TextInput
        accessibilityLabel={title}
        autoCapitalize={title === "Username" ? "none" : "words"}
        autoCorrect={title !== "Username"}
          placeholder={placeholder}
          placeholderTextColor="#A6A6AE"
          className="text-white text-[15px] font-nata outline-none w-full h-full"
          {...rest}
        />
      </View>
    </View>
  );
}
