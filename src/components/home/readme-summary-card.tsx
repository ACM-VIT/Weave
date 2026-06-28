import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import BookIcon from "@/assets/icons/book.svg";
import ReadFullText from "@/assets/icons/read-full.svg";
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
      <View style={styles.bodyContainer}>
        <Text selectable numberOfLines={10} style={styles.body}>
          {summary}
        </Text>
      </View>
      <View style={styles.footer}>
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
          <ReadFullText width={44} height={8} />
          <Text style={styles.chevron}>{">"}</Text>
        </AnimatedPressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.page,
    borderColor: colors.cardStroke,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 16,
    minHeight: 240,
    flexDirection: 'column',
  },
  headingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    marginBottom: 12,
  },
  heading: {
    color: colors.accent,
    fontFamily: fonts.medium,
    fontSize: 16,
    lineHeight: 22
  },
  bodyContainer: {
    flex: 1, // Takes up remaining space
  },
  body: {
    color: colors.white,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 20
  },
  footer: {
    marginTop: 12, // Pushes to bottom if flex:1 above works, otherwise just adds space
  },
  readFull: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 3,
    minHeight: 20,
    minWidth: 68
  },
  chevron: {
    color: colors.accent,
    fontFamily: fonts.bold,
    fontSize: 16,
    lineHeight: 16,
    marginTop: -1
  }
});

