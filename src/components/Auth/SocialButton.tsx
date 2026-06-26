import { ReactNode } from "react";
import {
  Text,
  TouchableOpacity,
  TouchableOpacityProps,
  View,
} from "react-native";
import { ChevronRightIcon } from "./icons";

interface SocialButtonProps extends TouchableOpacityProps {
  label: string;
  icon: ReactNode;
  showChevron?: boolean;
}

export default function SocialButton({
  label,
  icon,
  showChevron = false,
  ...props
}: SocialButtonProps) {
  return (
    <TouchableOpacity
      className="flex-row items-center bg-[#191F18] border-2 border-[#6DA963] rounded-[9px] h-[61px] px-4"
      activeOpacity={0.75}
      {...props}
    >
      <View className="w-8 items-center">
        {icon}
      </View>

      <Text
        className="flex-1 ml-3 text-white text-[16px] font-nata"
      >
        {label}
      </Text>

      {showChevron && (
        <ChevronRightIcon size={20} color="#6DA963" />
      )}
    </TouchableOpacity>
  );
}