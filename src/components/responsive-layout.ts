import { ViewStyle } from 'react-native';

export function getResponsiveContentWidth(width: number) {
  if (width < 768) {
    return undefined;
  }

  if (width < 1024) {
    return 700;
  }

  return 460;
}

export function getResponsiveContainerStyle(width: number): ViewStyle {
  const maxWidth = getResponsiveContentWidth(width);

  if (!maxWidth) {
    return { width: '100%' };
  }

  return {
    width: '100%',
    maxWidth,
    alignSelf: 'center',
  };
}
