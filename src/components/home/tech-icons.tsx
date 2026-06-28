import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Ellipse, G, Path } from "react-native-svg";
import { colors, fonts } from "@/constants/colors";
import type { TechName } from "@/types/repository";

interface TechIconProps {
  name: TechName;
}

export const TechIcon = memo(function TechIcon({ name }: TechIconProps) {
  return (
    <View style={styles.item}>
      <View style={styles.iconBox}>{renderIcon(name)}</View>
      <Text selectable style={styles.label}>
        {name}
      </Text>
    </View>
  );
});

function renderIcon(name: TechName) {
  switch (name) {
    case "React":
      return <ReactMark />;
    case "MongoDB":
      return <MongoMark />;
    case "Tailwind":
      return <TailwindMark />;
    case "Javascript":
      return <JavaMark />;
    case "Python":
      return <PythonMark />;
    case "Android SDK":
      return <AndroidMark />;
    default:
      return null;
  }
}

function ReactMark() {
  return (
    <Svg width={31} height={31} viewBox="0 0 31 31">
      <Circle cx={15.5} cy={15.5} r={3.1} fill={colors.reactPink} />
      <Ellipse cx={15.5} cy={15.5} rx={13.5} ry={5.3} stroke={colors.reactPink} strokeWidth={1.4} />
      <Ellipse cx={15.5} cy={15.5} rx={13.5} ry={5.3} stroke={colors.reactPink} strokeWidth={1.4} transform="rotate(60 15.5 15.5)" />
      <Ellipse cx={15.5} cy={15.5} rx={13.5} ry={5.3} stroke={colors.reactPink} strokeWidth={1.4} transform="rotate(120 15.5 15.5)" />
    </Svg>
  );
}

function MongoMark() {
  return (
    <Svg width={31} height={31} viewBox="0 0 31 31">
      <Path
        d="M15.4 1.8C20.7 5.8 24 10.2 22.2 16.8C21.2 20.5 18.7 23.4 16.2 25.2C13.2 21.8 10.2 18.4 10.6 13.5C10.9 9 13 5.2 15.4 1.8Z"
        fill="#53FA3A"
      />
      <Path d="M15.7 7.1C15.3 12.4 15.2 18.2 16.2 25.2" stroke="#0D0E0D" strokeWidth={1.2} strokeLinecap="round" />
    </Svg>
  );
}

function TailwindMark() {
  return (
    <Svg width={38} height={25} viewBox="0 0 38 25">
      <Path
        d="M11 7.5C13.1 2.7 16.8 0.9 22.1 2.1C25.3 2.8 27.2 4.6 28.1 7.5C29.8 6 32 5.6 34.7 6.4C31.9 10.7 28.1 12.3 23.5 11.1C20.5 10.3 18.8 8.7 18.3 6.3C16.5 7.8 14.1 8.2 11 7.5ZM3.1 17.5C5.2 12.7 8.9 10.9 14.2 12.1C17.4 12.8 19.3 14.6 20.2 17.5C21.9 16 24.1 15.6 26.8 16.4C24 20.7 20.2 22.3 15.6 21.1C12.6 20.3 10.9 18.7 10.4 16.3C8.6 17.8 6.2 18.2 3.1 17.5Z"
        fill="#72D7FF"
      />
    </Svg>
  );
}

function JavaMark() {
  return (
    <Svg width={31} height={31} viewBox="0 0 31 31">
      <Path d="M17.8 2.5C14 5.3 23.3 7.2 15.1 11.5" stroke={colors.orange} strokeWidth={1.7} strokeLinecap="round" />
      <Path d="M15 9.9C11.9 12.2 19.7 13.8 13.2 17.3" stroke={colors.orange} strokeWidth={1.5} strokeLinecap="round" />
      <Path d="M8.5 18.2C12.2 20.2 19.7 20 23 17.9" stroke={colors.slateBlue} strokeWidth={1.5} strokeLinecap="round" />
      <Path d="M7.8 21.2C12.1 23.4 21 22.9 24.3 20.5" stroke={colors.slateBlue} strokeWidth={1.5} strokeLinecap="round" />
      <Path d="M10.2 24.5C13.7 25.6 20 25.4 22.8 23.7" stroke={colors.slateBlue} strokeWidth={1.4} strokeLinecap="round" />
    </Svg>
  );
}

function PythonMark() {
  return (
    <Svg width={31} height={31} viewBox="0 0 31 31">
      <Path d="M8 14.5C8 9.2 10.6 6.7 15.8 6.7H22.8C24.6 6.7 26 8.1 26 9.9V14H16.5C14.7 14 13.2 15.5 13.2 17.3V18.5H11.2C9.4 18.5 8 17 8 15.2V14.5Z" fill={colors.blue} />
      <Path d="M23 16.5C23 21.8 20.4 24.3 15.2 24.3H8.2C6.4 24.3 5 22.9 5 21.1V17H14.5C16.3 17 17.8 15.5 17.8 13.7V12.5H19.8C21.6 12.5 23 14 23 15.8V16.5Z" fill={colors.pythonYellow} />
      <Circle cx={14.1} cy={9.5} r={1} fill={colors.white} />
      <Circle cx={16.9} cy={21.5} r={1} fill={colors.white} />
    </Svg>
  );
}

function AndroidMark() {
  return (
    <Svg width={31} height={31} viewBox="0 0 31 31">
      <G fill="#A4C439">
        <Path d="M9 12.8h13v8.8c0 1.5-1.2 2.7-2.7 2.7H11.7C10.2 24.3 9 23.1 9 21.6v-8.8Z" />
        <Path d="M10.3 11.5C10.9 8.2 13 6 15.5 6s4.6 2.2 5.2 5.5H10.3Z" />
        <Path d="M6.5 13h1.8v8H6.5zM22.7 13h1.8v8h-1.8zM12 24h1.8v3H12zM17.2 24H19v3h-1.8z" />
      </G>
      <Path d="M11.8 5.1 9.9 2.4M19.2 5.1l1.9-2.7" stroke="#A4C439" strokeWidth={1.2} strokeLinecap="round" />
      <Circle cx={13.1} cy={9.5} r={0.8} fill={colors.page} />
      <Circle cx={17.9} cy={9.5} r={0.8} fill={colors.page} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  item: {
    alignItems: "center",
    height: 52,
    justifyContent: "flex-start",
    width: 72
  },
  iconBox: {
    alignItems: "center",
    height: 34,
    justifyContent: "center",
    width: 54
  },
  label: {
    color: colors.white,
    fontFamily: fonts.regular,
    fontSize: 8.5,
    lineHeight: 12,
    textAlign: "center"
  }
});
