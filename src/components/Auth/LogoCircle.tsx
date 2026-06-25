import { Text, View } from "react-native";

interface LogoCircleProps {
  size?: number;
}

export default function LogoCircle({ size = 190 }: LogoCircleProps) {
  const radius = size / 2;

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
      }}
      className="bg-[#1A281E] items-center justify-center"
    >
      <Text
        className="font-nataSemiBold text-white text-2xl tracking-widest"
      >
        Logo
      </Text>
    </View>
  );
}