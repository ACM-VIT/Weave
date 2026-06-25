import {
    Text,
    TouchableOpacity,
} from "react-native";

type PrimaryButtonProps = {
  title: string;
  onPress?: () => void;
};

export default function PrimaryButton({
  title,
  onPress,
}: PrimaryButtonProps) {
  return (
    <TouchableOpacity
      onPress={onPress}
      className="
        bg-[#6DA963]
        rounded-[18px]
        py-4
        items-center
      "
    >
      <Text
  className="text-lg font-bold"
  style={{
    color: "#F0F6EB",
  }}
    >
        {title}
      </Text>
    </TouchableOpacity>
  );
}