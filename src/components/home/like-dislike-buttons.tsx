import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring } from "react-native-reanimated";
import { ThumbsDown, ThumbsUp } from "lucide-react-native";
import { fonts } from "@/constants/colors";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface LikeDislikeButtonsProps {
  repositoryId: string;
  likes: number;
  dislikes: number;
  reaction: "like" | "dislike" | null;
  onReaction: (id: string, reaction: "like" | "dislike") => void;
}

export const LikeDislikeButtons = memo(function LikeDislikeButtons({
  repositoryId,
  likes,
  dislikes,
  reaction,
  onReaction
}: LikeDislikeButtonsProps) {
  return (
    <View style={styles.stack}>
      <ReactionButton
        accessibilityLabel="Like repository"
        active={reaction === "like"}
        count={formatCount(likes)}
        type="like"
        onPress={() => onReaction(repositoryId, "like")}
      />
      <ReactionButton
        accessibilityLabel="Dislike repository"
        active={reaction === "dislike"}
        count={formatCount(dislikes)}
        type="dislike"
        onPress={() => onReaction(repositoryId, "dislike")}
      />
    </View>
  );
});

function ReactionButton({
  accessibilityLabel,
  active,
  count,
  type,
  onPress
}: {
  accessibilityLabel: string;
  active: boolean;
  count: string;
  type: "like" | "dislike";
  onPress: () => void;
}) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  const Icon = type === "like" ? ThumbsUp : ThumbsDown;

  return (
    <View style={styles.buttonContainer}>
      <AnimatedPressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => {
          scale.set(withSequence(withSpring(0.88, { damping: 11, stiffness: 300 }), withSpring(1, { damping: 10, stiffness: 240 })));
          onPress();
        }}
        style={[styles.button, animatedStyle]}
      >
        <Icon color="#84FF70" fill={active ? "#84FF70" : "transparent"} size={16} strokeWidth={2.4} />
      </AnimatedPressable>
      <Text style={[styles.count, active && styles.countActive]}>{count}</Text>
    </View>
  );
}

function formatCount(value: number) {
  if (value >= 1000) {
    const formatted = value / 1000;
    return `${Number.isInteger(formatted) ? formatted.toFixed(0) : formatted.toFixed(1)}k`;
  }
  return `${value}`;
}

const styles = StyleSheet.create({
  stack: {
    gap: 16,
    alignItems: 'center',
  },
  buttonContainer: {
    alignItems: 'center',
    gap: 4,
  },
  button: {
    alignItems: "center",
    backgroundColor: "#151714",
    borderColor: "#84FF70",
    borderRadius: 20,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  count: {
    color: "#D9D9D9",
    fontFamily: fonts.regular,
    fontSize: 10,
    fontVariant: ["tabular-nums"],
  },
  countActive: {
    color: "#84FF70"
  }
});
