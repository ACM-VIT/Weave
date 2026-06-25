import { View } from 'react-native';
import Animated, { Keyframe, Easing } from 'react-native-reanimated';

const DURATION = 300;

export function AnimatedSplashOverlay() {
  return null;
}

const keyframe = new Keyframe({
  0: { transform: [{ scale: 0 }] },
  60: { transform: [{ scale: 1.2 }], easing: Easing.elastic(1.2) },
  100: { transform: [{ scale: 1 }], easing: Easing.elastic(1.2) },
});

const logoKeyframe = new Keyframe({
  0: { opacity: 0 },
  60: { transform: [{ scale: 1.2 }], opacity: 0, easing: Easing.elastic(1.2) },
  100: { transform: [{ scale: 1 }], opacity: 1, easing: Easing.elastic(1.2) },
});

export function AnimatedIcon() {
  return (
    <View className="justify-center items-center w-[128px] h-[128px]">
      <Animated.View className="w-[128px] h-[128px] absolute" entering={keyframe.duration(DURATION)}>
        <View className="bg-[#0274DF] rounded-[40px] w-[128px] h-[128px]" />
      </Animated.View>

      <Animated.View className="justify-center items-center" entering={logoKeyframe.duration(DURATION)}>
        <View className="w-[76px] h-[71px] bg-white/20 rounded-xl" />
      </Animated.View>
    </View>
  );
}
