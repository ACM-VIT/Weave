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
        bg-[#191F18]
        border border-[#6DA963]
        rounded-xl
        px-5
        justify-center"
      >
        <TextInput
          placeholder={placeholder}
          placeholderTextColor="#666"
          className="text-white text-[15px] font-nata outline-none w-full h-full"
          {...rest}
        />
      </View>
    </View>
  );
}