import React, { memo, useCallback } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Path } from "react-native-svg";
import Branch1 from "@/assets/branches/branch-1.svg";
import Branch2 from "@/assets/branches/branch-2.svg";
import Branch3 from "@/assets/branches/branch-3.svg";
import { colors } from "@/constants/colors";
import type { Repository } from "@/types/repository";
import { DescriptionCard } from "./description-card";
import { LikeDislikeButtons } from "./like-dislike-buttons";
import { OwnerStats } from "./owner-stats";
import { ReadmeSummaryCard } from "./readme-summary-card";
import { RepositoryHeader } from "./repository-header";
import { TechStackCard } from "./tech-stack-card";

interface RepositoryCardProps {
  repository: Repository;
  viewportHeight: number;
  counts: {
    likes: number;
    dislikes: number;
  };
  reaction: "like" | "dislike" | null;
  onOpenReadme: () => void;
  onReaction: (id: string, reaction: "like" | "dislike") => void;
  onSaveRepository?: () => void;
}

const SWIPE_THRESHOLD = 80;
const TIMELINE_X = 19;
const DOT_CENTER_X = 20;
const DOT_CENTER_Y = 7;
const HEADER_DOT_CENTER_Y = 16;
const DOT_SIZE = 14;
const HORIZONTAL_BRANCH_WIDTH = 21;
const BRANCH1_HEIGHT = 146;
const BRANCH1_CURVE_START = 125;
const BRANCH1_CURVE_HEIGHT = BRANCH1_HEIGHT - BRANCH1_CURVE_START;

function TimelineVertical({
  top,
  height,
  bottom,
}: {
  top?: number;
  height?: number;
  bottom?: number;
}) {
  return (
    <Branch2
      width={2}
      preserveAspectRatio="none"
      pointerEvents="none"
      style={[styles.branchVertical, { top, height, bottom }]}
    />
  );
}

function HorizontalDotBranch() {
  return (
    <Branch3
      width={HORIZONTAL_BRANCH_WIDTH}
      height={2}
      preserveAspectRatio="none"
      pointerEvents="none"
      style={styles.branchHorizontal}
    />
  );
}

function ReadmeDotBranch() {
  return (
    <View pointerEvents="none" style={styles.readmeBranchClip}>
      <Branch1
        width={35}
        height={BRANCH1_HEIGHT}
        pointerEvents="none"
        style={styles.readmeBranchOffset}
      />
    </View>
  );
}

export const RepositoryCard = memo(function RepositoryCard({
  repository,
  viewportHeight,
  counts,
  reaction,
  onOpenReadme,
  onReaction,
  onSaveRepository,
}: RepositoryCardProps) {
  const translateX = useSharedValue(0);

  const snapBack = useCallback(() => {
    translateX.value = withSpring(0, { damping: 22, stiffness: 220 });
  }, [translateX]);

  const triggerSave = useCallback(() => {
    onSaveRepository?.();
    translateX.value = withSpring(0, { damping: 22, stiffness: 220 });
  }, [onSaveRepository, translateX]);

  const panGesture = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-16, 16])
    .onUpdate((event) => {
      const next = Math.min(0, event.translationX);
      translateX.value = next;
    })
    .onEnd((event) => {
      const isHorizontalSwipe = Math.abs(event.translationX) > Math.abs(event.translationY);
      if (translateX.value < -SWIPE_THRESHOLD || (isHorizontalSwipe && event.velocityX < -600)) {
        runOnJS(triggerSave)();
      } else {
        runOnJS(snapBack)();
      }
    });

  const animatedCardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View style={[styles.page, { height: viewportHeight }]}>
      <GestureDetector gesture={panGesture}>
        <Animated.View style={[styles.mainContent, animatedCardStyle]}>
          <View style={styles.cardContainer}>
            {/* Row 1: Header */}
            <View style={styles.row}>
              <View style={styles.timelineColumnHeader}>
                <TimelineVertical top={HEADER_DOT_CENTER_Y} bottom={0} />
                <View style={styles.connectorDot} />
              </View>
              <View style={styles.contentColumn}>
                <RepositoryHeader title={repository.title} />
              </View>
            </View>

            {/* Row 2a: Merged Box - Description Part */}
            <View style={[styles.row, { marginTop: 24 }]}>
              <View style={styles.timelineColumn}>
                <TimelineVertical top={-25} bottom={0} />
                <HorizontalDotBranch />
                <View style={styles.connectorDot} />
              </View>
              <View style={[styles.contentColumn, styles.cardBoxTop]}>
                <DescriptionCard description={repository.description} />
              </View>
            </View>

            {/* Row 2b: Merged Box - Tech Stack Part */}
            <View style={styles.row}>
              <View style={styles.timelineColumn}>
                <TimelineVertical top={-1} bottom={0} />
                <HorizontalDotBranch />
                <View style={styles.connectorDot} />
              </View>
              <View style={[styles.contentColumn, styles.cardBoxBottom]}>
                <TechStackCard techStack={repository.techStack} />
              </View>
            </View>

            {/* Row 4: README Summary Box */}
            <View style={[styles.row, { marginTop: 24 }]}>
              <View style={styles.timelineColumn}>
                <TimelineVertical top={-25} bottom={0} />
                <ReadmeDotBranch />
                <View style={styles.connectorDot} />
              </View>
              <View style={[styles.contentColumn, { flexDirection: "row", alignItems: "center" }]}>
                <View style={{ flex: 1 }}>
                  <ReadmeSummaryCard summary={repository.readmeSummary} onOpenReadme={onOpenReadme} />
                </View>

                <View style={styles.likeDislikeWrapper}>
                  <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                    <Path
                      d="M 0 56 L 12 56 C 16 56, 16 52, 16 48 L 16 8 C 16 4, 20 0, 48 0 L 52 0"
                      stroke="#84FF70"
                      strokeWidth={2}
                      fill="none"
                    />
                  </Svg>
                  <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                    <Path
                      d="M 0 56 L 12 56 C 16 56, 16 60, 16 64 L 16 104 C 16 108, 48 110 L 52 110"
                      stroke="#84FF70"
                      strokeWidth={2}
                      fill="none"
                    />
                  </Svg>

                  <View style={styles.actionPanel}>
                    <LikeDislikeButtons
                      repositoryId={repository.id}
                      likes={counts.likes}
                      dislikes={counts.dislikes}
                      reaction={reaction}
                      onReaction={onReaction}
                    />
                  </View>
                </View>
              </View>
            </View>

            {/* Row 5: Profile Row */}
            <View style={[styles.row, { marginTop: 24, alignItems: "center" }]}>
              <View style={styles.timelineColumnProfile}>
                <View style={styles.avatar} />
              </View>
              <View style={styles.contentColumn}>
                <OwnerStats owner={repository.owner} stars={repository.stars} watchers={repository.watchers} forks={repository.forks} />
              </View>
            </View>
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
});

const styles = StyleSheet.create({
  page: {
    width: "100%",
    backgroundColor: colors.black,
    justifyContent: "center",
  },
  mainContent: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  cardContainer: {
    backgroundColor: colors.page,
    borderRadius: 16,
    paddingVertical: 24,
    paddingRight: 16,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    width: "100%",
  },
  timelineColumnHeader: {
    width: 40,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  timelineColumn: {
    width: 40,
    alignItems: "center",
    position: "relative",
  },
  timelineColumnProfile: {
    width: 40,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  branchVertical: {
    position: "absolute",
    left: TIMELINE_X,
    top: 0,
    bottom: 0,
    zIndex: 0,
  },
  branchHorizontal: {
    position: "absolute",
    left: DOT_CENTER_X,
    top: DOT_CENTER_Y - 1,
    zIndex: 1,
  },
  readmeBranchClip: {
    position: "absolute",
    left: TIMELINE_X,
    top: DOT_CENTER_Y,
    width: 35,
    height: BRANCH1_CURVE_HEIGHT + 9,
    overflow: "hidden",
    zIndex: 1,
  },
  readmeBranchOffset: {
    position: "absolute",
    left: 0,
    top: -BRANCH1_CURVE_START,
  },
  connectorDot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    borderWidth: 2,
    borderColor: "#84FF70",
    backgroundColor: "#FFFFFF",
    zIndex: 2,
  },
  contentColumn: {
    flex: 1,
  },
  cardBoxTop: {
    backgroundColor: colors.cardSurface,
    borderColor: colors.cardStroke,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 10,
  },
  cardBoxBottom: {
    backgroundColor: colors.cardSurface,
    borderColor: colors.cardStroke,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    borderWidth: 1,
    borderTopWidth: 0,
    paddingHorizontal: 12,
    paddingBottom: 16,
    paddingTop: 10,
  },
  avatar: {
    backgroundColor: "#84FF70",
    borderRadius: 17,
    height: 34,
    width: 34,
    zIndex: 2,
  },
  likeDislikeWrapper: {
    width: 72,
    height: 128,
    position: "relative",
  },
  actionPanel: {
    position: "absolute",
    right: 0,
    width: 40,
    zIndex: 2,
  },
});
