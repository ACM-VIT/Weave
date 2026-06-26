import { Text, TouchableOpacity, View } from "react-native";

type SkillCardProps = {
  title: string;
  icon: string;
  selected?: boolean;
  onPress?: () => void;
};

export default function SkillCard({
  title,
  icon,
  selected = false,
  onPress,
}: SkillCardProps) {
  return (
    <TouchableOpacity
      onPress={onPress ?? (() => {})}
      style={{
        width: "48%",
        backgroundColor: "#191F18",
        borderColor: selected ? "#6DA963" : "#555252",
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        flexDirection: "row",
        alignItems: "center",
        marginBottom: 12,
      }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          backgroundColor: "#2A332B",
          justifyContent: "center",
          alignItems: "center",
          marginRight: 6,
        }}
      >
        <Text
          style={{
            color: "#F0F6EB",
            fontWeight: "600",
            fontSize: 12,
          }}
        >
          {icon}
        </Text>
      </View>

      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          color: "#F0F6EB",
          fontSize: 12,
          lineHeight: 18,
        }}
      >
        {title}
      </Text>

      {selected && (
        <Text
          style={{
            color: "#6DA963",
            fontSize: 16,
            fontWeight: "700",
          }}
        >
          ✓
        </Text>
      )}
    </TouchableOpacity>
  );
}