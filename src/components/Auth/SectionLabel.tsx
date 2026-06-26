import { Text } from "react-native";

export default function SectionLabel({
  title,
}: {
  title: string;
}) {
  return (
    <Text className="font-nata text-white text-[14px] mt-7 mb-3">
      {title}
    </Text>
  );
}