import { memo, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { GitFork, Star } from "lucide-react-native";
import { colors, fonts } from "@/constants/colors";

interface OwnerStatsProps {
  owner: string;
  stars: string;
  watchers: string;
  forks: string;
}

export const OwnerStats = memo(function OwnerStats({ owner, stars, watchers, forks }: OwnerStatsProps) {
  return (
    <View style={styles.wrap}>
      <Text selectable style={styles.owner}>
        {owner}
      </Text>
      <View style={styles.statsRow}>
        <Stat icon={<Star color={colors.accent} size={16} strokeWidth={1.8} />} value={stars} />
        <Stat icon={<EyeMark />} value={watchers} />
        <Stat icon={<GitFork color={colors.accent} size={14} strokeWidth={2.1} />} value={forks} />
      </View>
    </View>
  );
});

function Stat({ icon, value }: { icon: ReactNode; value: string }) {
  return (
    <View style={styles.stat}>
      {icon}
      <Text selectable style={styles.statValue}>
        {value}
      </Text>
    </View>
  );
}

function EyeMark() {
  return (
    <Svg width={17} height={13} viewBox="0 0 17 13">
      <Path d="M1 6.5C2.9 2.7 5.4 1 8.5 1C11.6 1 14.1 2.7 16 6.5C14.1 10.3 11.6 12 8.5 12C5.4 12 2.9 10.3 1 6.5Z" stroke={colors.accent} strokeWidth={1.5} fill="transparent" />
      <Circle cx={8.5} cy={6.5} r={2.1} fill={colors.accent} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 4,
    justifyContent: "center",
  },
  owner: {
    color: colors.white,
    fontFamily: fonts.regular,
    fontSize: 18,
    lineHeight: 24,
  },
  statsRow: {
    flexDirection: "row",
    gap: 16,
  },
  stat: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
  },
  statValue: {
    color: colors.white,
    fontFamily: fonts.regular,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    lineHeight: 15,
  },
});
