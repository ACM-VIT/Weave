import { Text, TouchableOpacity, TouchableOpacityProps } from "react-native";

interface PrimaryButtonProps extends TouchableOpacityProps {
  label: string;
}

export default function PrimaryButton({
  label,
  disabled = false,
  style,
  ...props
}: PrimaryButtonProps) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      className="min-h-[52px] rounded-[9px] items-center justify-center"
      disabled={disabled}
      style={[
        { backgroundColor: disabled ? "#1C1C1E" : "#FFFFFF" },
        style,
      ]}
      activeOpacity={0.8}
      {...props}
    >
      <Text
        className="font-nataSemiBold text-[16px] tracking-wide"
        style={{ color: disabled ? "rgba(235,235,245,0.35)" : "#000000" }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}
