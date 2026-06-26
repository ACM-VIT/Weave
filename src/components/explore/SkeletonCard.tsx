import React, { useEffect, useState } from 'react';
import { Animated } from 'react-native';

interface SkeletonCardProps {
  height?: number;
}

export default function SkeletonCard({ height = 80 }: SkeletonCardProps): React.JSX.Element {
  const [opacity] = useState(() => new Animated.Value(0.4));

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.7,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.4,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={{
        height,
        backgroundColor: '#191F18',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#2E3D2E',
        opacity,
      }}
    />
  );
}