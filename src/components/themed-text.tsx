import { Platform, Text, type TextProps } from 'react-native';
import { ThemeColor } from '@/constants/theme';

export type ThemedTextProps = TextProps & {
  type?: 'default' | 'title' | 'small' | 'smallBold' | 'subtitle' | 'link' | 'linkPrimary' | 'code';
  themeColor?: ThemeColor;
};

const typeClasses = {
  small: 'text-[14px] leading-[20px] font-medium',
  smallBold: 'text-[14px] leading-[20px] font-bold',
  default: 'text-[16px] leading-[24px] font-medium',
  title: 'text-[48px] leading-[52px] font-semibold',
  subtitle: 'text-[32px] leading-[44px] font-semibold',
  link: 'text-[14px] leading-[30px]',
  linkPrimary: 'text-[14px] leading-[30px] text-[#3c87f7]',
};

const colorClasses = {
  text: 'text-[#000000] dark:text-[#ffffff]',
  textSecondary: 'text-[#60646C] dark:text-[#B0B4BA]',
  background: 'text-[#ffffff] dark:text-[#000000]',
  backgroundElement: 'text-[#F0F0F3] dark:text-[#212225]',
  backgroundSelected: 'text-[#E0E1E6] dark:text-[#2E3135]',
};

export function ThemedText({ className, type = 'default', themeColor, ...rest }: ThemedTextProps) {
  const typeClass = type === 'code'
    ? `font-mono text-[12px] ${Platform.OS === 'android' ? 'font-bold' : 'font-medium'}`
    : (typeClasses[type] || '');

  // If type is linkPrimary, the text color is already inline in typeClasses (#3c87f7)
  const resolvedColorClass = themeColor
    ? (colorClasses[themeColor] || '')
    : (type === 'linkPrimary' ? '' : colorClasses.text);

  return (
    <Text
      className={`${typeClass} ${resolvedColorClass} ${className ?? ''}`}
      {...rest}
    />
  );
}
