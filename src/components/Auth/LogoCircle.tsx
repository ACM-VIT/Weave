import { View } from "react-native";
import WeaveSymbol from '@/assets/images/logo/weave-symbol.svg';

interface LogoCircleProps {
  size?: number;
}

export default function LogoCircle({ size = 190 }: LogoCircleProps) {
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
