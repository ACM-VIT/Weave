import { Text, TouchableOpacity, TouchableOpacityProps } from "react-native";

interface PrimaryButtonProps extends TouchableOpacityProps {
  label: string;
}

export default function PrimaryButton({
  label,
  ...props
}: PrimaryButtonProps) {
  return (
    <TouchableOpacity
      className="bg-[#6DA963] h-[52px] rounded-[9px] items-center justify-center"
      activeOpacity={0.8}
      {...props}
    >
      <Text
        className="font-nataSemiBold text-white text-[16px] tracking-wide"
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}