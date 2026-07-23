/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'Nata Sans',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'Nata Sans',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;

/**
 * Visual tokens taken directly from the bundled GH Social Reels reference.
 * Keep feature-specific semantic colours (stars, errors, success) separate
 * from the configurable green accent used by the reference prototype.
 */
export const REFERENCE_THEME = {
  background: '#000000',
  canvas: '#0A0A0C',
  surface: '#1C1C1E',
  surfaceElevated: '#2C2C2E',
  accent: '#30D158',
  accentDark: '#23963F',
  accentLight: '#87E49E',
  text: '#FFFFFF',
  textStrong: 'rgba(235,235,245,0.85)',
  textPrimary: 'rgba(235,235,245,0.75)',
  textSecondary: 'rgba(235,235,245,0.60)',
  textTertiary: 'rgba(235,235,245,0.45)',
  textDisabled: 'rgba(235,235,245,0.35)',
  control: 'rgba(118,118,128,0.18)',
  controlStrong: 'rgba(118,118,128,0.24)',
  separator: 'rgba(255,255,255,0.07)',
  border: 'rgba(255,255,255,0.12)',
  inactive: '#7C7C82',
  star: '#FFD60A',
  danger: '#FF453A',
  heart: '#FF375F',
  success: '#30D158',
} as const;

export const APP_THEME = {
  background: '#0A0C09',
  primary: '#63E08A',
  primaryForeground: '#071009',
  activeAccent: '#F7F7F8',
  inactiveAccent: '#77767C',
  borderDark: '#242524',
  tabBarBackground: '#0A0C09',
  tabBarBorder: '#0A0C09',
} as const;
