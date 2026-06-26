import { ViewStyle } from "react-native";

export function getResponsiveContentWidth(width: number) {
  // Phones: use the full screen width
  if (width < 768) {
    return undefined;
  }

  // Tablets & desktop: centered feed with a larger max width
  return Math.min(width * 0.9, 900);
}

export function getResponsiveContainerStyle(width: number): ViewStyle {
  const maxWidth = getResponsiveContentWidth(width);

  if (!maxWidth) {
    return {
      width: "100%",
    };
  }

  return {
    width: "100%",
    maxWidth,
    alignSelf: "center",
  };
}