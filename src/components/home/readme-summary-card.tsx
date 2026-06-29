import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import BookIcon from "@/assets/icons/book.svg";
import { colors, fonts } from "@/constants/colors";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ReadmeSummaryCardProps {
  summary: string;
  onOpenReadme: () => void;
}

export const ReadmeSummaryCard = memo(function ReadmeSummaryCard({ summary, onOpenReadme }: ReadmeSummaryCardProps) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));

  return (
    <View style={styles.card}>
      <View style={styles.headingRow}>
        <BookIcon width={25} height={25} />
        <Text selectable style={styles.heading}>
          README Summary
        </Text>
      </View>
      <Text selectable numberOfLines={10} style={styles.body}>
        {summary}
      </Text>
      <AnimatedPressable
        accessibilityLabel="Read the full README summary"
        hitSlop={12}
        onPress={onOpenReadme}
        onPressIn={() => {
          scale.set(withSpring(0.94, { damping: 14, stiffness: 260 }));
        }}
        onPressOut={() => {
          scale.set(withSpring(1, { damping: 12, stiffness: 220 }));
        }}
        style={[styles.readFull, animatedStyle]}
      >
        <Text style={styles.readFullText}>Read Full {">"}</Text>
      </AnimatedPressable>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardSurface,
    borderColor: colors.cardStroke,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 16,
    gap: 12,
  },
  headingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  heading: {
    color: colors.accent,
    fontFamily: fonts.medium,
    fontSize: 16,
    lineHeight: 22,
  },
  body: {
    color: colors.white,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  readFull: {
    alignSelf: "flex-start",
  },
  readFullText: {
    color: colors.accent,
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 20,
  },
});
