import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import DescriptionIcon from "@/assets/icons/description.svg";
import { colors, fonts } from "@/constants/colors";

interface DescriptionCardProps {
  description: string;
}

export const DescriptionCard = memo(function DescriptionCard({ description }: DescriptionCardProps) {
  return (
    <View style={styles.section}>
      <View style={styles.headingRow}>
        <DescriptionIcon width={17} height={17} />
        <Text selectable style={styles.heading}>
          Description
        </Text>
      </View>
      <Text selectable style={styles.body}>
        {description}
      </Text>
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
    gap: 7
  },
  heading: {
    color: colors.accent,
    fontFamily: fonts.medium,
    fontSize: 16,
    lineHeight: 22
  },
  body: {
    color: colors.white,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 19
  }
});
