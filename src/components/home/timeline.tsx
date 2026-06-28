import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/constants/colors";

interface TimelineProps {
  height: number;
}

export const Timeline = memo(function Timeline({ height }: TimelineProps) {
  return (
    <View pointerEvents="none" style={[styles.wrap, { height }]}>
      <View style={styles.line} />
      <TimelineNode top={0} />
      <TimelineNode top={157} />
      <TimelineNode top={313} />
      <View style={styles.connectorOne} />
      <View style={styles.connectorTwo} />
    </View>
  );
});

function TimelineNode({ top }: { top: number }) {
  return (
    <View style={[styles.nodeOuter, { top }]}>
      <View style={styles.nodeInner} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    left: 5,
    position: "absolute",
    top: 38,
    width: 43
  },
  line: {
    backgroundColor: colors.accent,
    bottom: 0,
    left: 9,
    position: "absolute",
    top: 10,
    width: 1
  },
  nodeOuter: {
    alignItems: "center",
    backgroundColor: colors.black,
    borderColor: colors.accent,
    borderRadius: 10,
    borderWidth: 1,
    height: 20,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    width: 20
  },
  nodeInner: {
    backgroundColor: colors.white,
    borderRadius: 7,
    height: 14,
    width: 14
  },
  connectorOne: {
    backgroundColor: colors.accent,
    height: 1,
    left: 20,
    position: "absolute",
    top: 166,
    width: 31
  },
  connectorTwo: {
    backgroundColor: colors.accent,
    height: 1,
    left: 20,
    position: "absolute",
    top: 322,
    width: 31
  }
});
