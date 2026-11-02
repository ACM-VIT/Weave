import { View } from "react-native";
import WeaveSymbol from '@/assets/images/logo/weave-symbol.svg';

interface LogoPlaceholderProps {
  size?: number;
}

export default function LogoPlaceholder({ size = 190 }: LogoPlaceholderProps) {
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: size / 2,
        overflow: 'hidden',
      }}
    >
      <WeaveSymbol width={size * 0.7} height={size * 0.7 * (650 / 740)} accessible={false} />
    </View>
  );
}
