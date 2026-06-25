import { View, type ViewProps } from 'react-native';
import { ThemeColor } from '@/constants/theme';

export type ThemedViewProps = ViewProps & {
  type?: ThemeColor;
};

const bgClasses = {
  background: 'bg-[#ffffff] dark:bg-[#000000]',
  backgroundElement: 'bg-[#F0F0F3] dark:bg-[#212225]',
  backgroundSelected: 'bg-[#E0E1E6] dark:bg-[#2E3135]',
  text: 'bg-[#000000] dark:bg-[#ffffff]',
  textSecondary: 'bg-[#60646C] dark:bg-[#B0B4BA]',
};

export function ThemedView({ className, type = 'background', ...otherProps }: ThemedViewProps) {
  const bgClass = bgClasses[type] || '';

  return <View className={`${bgClass} ${className ?? ''}`} {...otherProps} />;
}
