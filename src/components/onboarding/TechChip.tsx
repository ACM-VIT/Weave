import React from "react";
import { Text, Pressable, View, Platform } from "react-native";

type TechChipProps = {
  title: string;
  image?: React.ReactNode;
  selected?: boolean;
  onPress?: () => void;
};

export default function TechChip({
  title,
  image,
  selected = false,
  onPress,
}: TechChipProps) {
  // RN Web's checkbox responder handles Enter, but not Space (unlike buttons).
  // Keep the native press path and add only the missing web key behavior.
  const keyboardProps = Platform.OS === 'web' ? {
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === ' ') {
        event.preventDefault();
        if (!event.repeat) onPress?.();
      }
    },
  } : {};

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={title}
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      {...keyboardProps}
      onPress={onPress}
      className={`rounded-xl px-3 py-2 mr-2 mb-2 flex-row items-center ${
        selected
          ? "bg-[#2C2C2E] border border-[#63E08A]"
          : "bg-[#1C1C1E] border border-[rgba(255,255,255,0.14)]"
      }`}
    >
      {image && <View className="mr-2">{image}</View>}
      <Text className="text-white text-sm">
        {title}
      </Text>

      <Text
        className={`ml-2 text-base ${
          selected
            ? "text-[#63E08A]"
            : "text-[rgba(235,235,245,0.45)]"
        }`}
      >
        {selected ? "×" : "+"}
      </Text>
    </Pressable>
  );
}
