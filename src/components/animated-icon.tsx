import { View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useState } from 'react';
import { Dimensions } from 'react-native';

const INITIAL_SCALE_FACTOR = Dimensions.get('screen').height / 90;
const DURATION = 600;

export function AnimatedSplashOverlay() {
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  const splashKeyframe = new Keyframe({
    0: { transform: [{ scale: INITIAL_SCALE_FACTOR }], opacity: 1 },
    20: { opacity: 1 },
    70: { opacity: 0, easing: Easing.elastic(0.7) },
    100: { opacity: 0, transform: [{ scale: 1 }], easing: Easing.elastic(0.7) },
  });

  return (
    <Animated.View
      entering={splashKeyframe.duration(DURATION).withCallback((finished) => {
        'worklet';
        if (finished) {
          scheduleOnRN(setVisible, false);
        }
      })}
      className="absolute inset-0 bg-[#208AEF] z-[1000]"
    />
  );
}

const keyframe = new Keyframe({
  0: { transform: [{ scale: INITIAL_SCALE_FACTOR }] },
  100: { transform: [{ scale: 1 }], easing: Easing.elastic(0.7) },
});

const logoKeyframe = new Keyframe({
  0: { transform: [{ scale: 1.3 }], opacity: 0 },
  40: { transform: [{ scale: 1.3 }], opacity: 0, easing: Easing.elastic(0.7) },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.elastic(0.7) },
});

export function AnimatedIcon() {
  return (
    <View className="justify-center items-center w-[128px] h-[128px] z-[100]">
      <Animated.View entering={keyframe.duration(DURATION)} className="rounded-[40px] bg-[#0274DF] w-[128px] h-[128px] absolute" />
      <Animated.View className="justify-center items-center" entering={logoKeyframe.duration(DURATION)}>
        <View className="w-[76px] h-[71px] bg-white/20 rounded-xl" />
      </Animated.View>
    </View>
  );
}
