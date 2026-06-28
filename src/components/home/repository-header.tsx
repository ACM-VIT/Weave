import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fonts } from "@/constants/colors";

interface RepositoryHeaderProps {
  title: string;
}

export const RepositoryHeader = memo(function RepositoryHeader({ title }: RepositoryHeaderProps) {
  return (
    <View style={styles.row}>
      <Text selectable style={styles.title}>
        {title}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    alignItems: "center",
    flexDirection: "row",
  },
  title: {
    color: colors.white,
    fontFamily: fonts.medium,
    fontSize: 25,
    lineHeight: 32,
  },
});
