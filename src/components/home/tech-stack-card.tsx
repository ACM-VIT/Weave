import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import TechStackIcon from "@/assets/icons/tech-stack.svg";
import { colors, fonts } from "@/constants/colors";
import type { TechName } from "@/types/repository";
import { TechIcon } from "./tech-icons";

interface TechStackCardProps {
  techStack: TechName[];
}

export const TechStackCard = memo(function TechStackCard({ techStack }: TechStackCardProps) {
  return (
    <View style={styles.section}>
      <View style={styles.headingRow}>
        <TechStackIcon width={16} height={18} />
        <Text selectable style={styles.heading}>
          Tech Stack
        </Text>
      </View>
      <View style={styles.grid}>
        {techStack.map((name) => (
          <TechIcon key={name} name={name} />
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  section: {
    gap: 8
  },
  headingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6
  },
  heading: {
    color: colors.techGreen,
    fontFamily: fonts.medium,
    fontSize: 16,
    lineHeight: 22
  },
  grid: {
    columnGap: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    paddingHorizontal: 5,
    rowGap: 3
  }
});
