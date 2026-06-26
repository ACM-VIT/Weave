import { View, Text } from "react-native";

type Props = {
  titleWhite: string;
  titleGreen: string;
  description: string;
};

export default function StepHeader({
  titleWhite,
  titleGreen,
  description,
}: Props) {
  return (
    <View
      style={{
        alignItems: "center",
        marginTop: 28,
      }}
    >
      <Text
        style={{
          color: "#F0F6EB",
          fontSize: 32,
          fontWeight: "700",
          textAlign: "center",
        }}
      >
        {titleWhite}
      </Text>

      <Text
        style={{
          color: "#6DA963",
          fontSize: 32,
          fontWeight: "700",
          textAlign: "center",
        }}
      >
        {titleGreen}
      </Text>

      <Text
        style={{
          color: "#9B9B9B",
          fontSize: 15,
          textAlign: "center",
          marginTop: 16,
          lineHeight: 22,
          paddingHorizontal: 24,
        }}
      >
        {description}
      </Text>
    </View>
  );
}