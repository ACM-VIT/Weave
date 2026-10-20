import {
    Text,
    TouchableOpacity,
} from "react-native";

type PrimaryButtonProps = {
  title: string;
  onPress?: () => void;
  disabled?: boolean;
};

export default function PrimaryButton({
  title,
  onPress,
  disabled = false,
}: PrimaryButtonProps) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      className="
        rounded-[18px]
        py-4
        items-center
      "
      style={{ backgroundColor: disabled ? "#1C1C1E" : "#63E08A" }}
    >
      <Text
        className="text-lg font-bold"
        style={{
          color: disabled ? "rgba(235,235,245,0.35)" : "#071009",
        }}
      >
        {title}
      </Text>
    </TouchableOpacity>
  );
}
