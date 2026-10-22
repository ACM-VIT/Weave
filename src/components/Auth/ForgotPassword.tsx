import { Text, TouchableOpacity, TouchableOpacityProps } from "react-native";

export default function ForgotPassword(
  props: TouchableOpacityProps
) {
  return (
    <TouchableOpacity accessibilityRole="button" style={{ minHeight: 48, justifyContent: "center" }} activeOpacity={0.7} {...props}>
      <Text
        className="text-[#63E08A] text-[13px] font-nata"
      >
        Forgot password?
      </Text>
    </TouchableOpacity>
  );
}
