import { memo, useEffect } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import BookIcon from "@/assets/icons/book.svg";
import { colors, fonts } from "@/constants/colors";
import type { Repository } from "@/types/repository";

interface ReadmeModalProps {
  repository: Repository | null;
  onClose: () => void;
}

export const ReadmeModal = memo(function ReadmeModal({ repository, onClose }: ReadmeModalProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.set(withTiming(repository ? 1 : 0, {
      duration: 180,
      easing: Easing.out(Easing.cubic)
    }));
  }, [progress, repository]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ scale: 0.94 + progress.get() * 0.06 }]
  }));

  const cardWidth = Math.min(width - 58, 343);
  const availableHeight = height - insets.top - insets.bottom - 96;
  const cardHeight = Math.min(695, Math.max(420, availableHeight));

  return (
    <Modal animationType="none" transparent visible={Boolean(repository)} onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.overlay}>
        <Animated.View
          style={[
            styles.card,
            cardStyle,
            {
              height: cardHeight,
              marginTop: Math.max(insets.top + 48, 68),
              width: cardWidth
            }
          ]}
        >
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <BookIcon width={22} height={22} />
              <Text selectable style={styles.title}>
                README Summary
              </Text>
            </View>
            <Pressable accessibilityLabel="Close README popup" accessibilityRole="button" onPress={onClose} style={styles.close}>
              <X color={colors.textMuted} size={28} strokeWidth={1.6} />
            </Pressable>
          </View>
          <ScrollView
            bounces={false}
            overScrollMode="never"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}
            style={styles.scroll}
          >
            <Text selectable style={styles.body}>
              {repository?.readmeFull}
            </Text>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  overlay: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.78)",
    flex: 1
  },
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.cardStroke,
    borderCurve: "continuous",
    borderRadius: 8,
    borderWidth: 1,
    paddingBottom: 18,
    paddingHorizontal: 20,
    paddingTop: 20
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 21
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7
  },
  title: {
    color: colors.accent,
    fontFamily: fonts.medium,
    fontSize: 16,
    lineHeight: 22
  },
  close: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    marginRight: -9,
    marginTop: -6,
    width: 44
  },
  scroll: {
    flex: 1
  },
  scrollContent: {
    paddingBottom: 22
  },
  body: {
    color: colors.white,
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 21,
    textAlign: "justify"
  }
});
