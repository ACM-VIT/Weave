import React, { useState } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { Plus, Sparkles, FolderGit2 } from 'lucide-react-native';
import Animated, { 
  useAnimatedStyle, 
  withSpring, 
  useSharedValue,
  interpolate
} from 'react-native-reanimated';

export function FloatingActions() {
  const [isOpen, setIsOpen] = useState(false);
  const animation = useSharedValue(0);

  const toggleMenu = () => {
    const toValue = isOpen ? 0 : 1;
    animation.value = withSpring(toValue, {
      damping: 15,
      stiffness: 100,
    });
    setIsOpen(!isOpen);
  };

  const action1Style = useAnimatedStyle(() => {
    const translateY = interpolate(animation.value, [0, 1], [0, -70]);
    const scale = interpolate(animation.value, [0, 1], [0, 1]);
    return {
      transform: [{ translateY }, { scale }],
      opacity: animation.value,
    };
  });

  const action2Style = useAnimatedStyle(() => {
    const translateY = interpolate(animation.value, [0, 1], [0, -130]);
    const scale = interpolate(animation.value, [0, 1], [0, 1]);
    return {
      transform: [{ translateY }, { scale }],
      opacity: animation.value,
    };
  });

  const mainButtonStyle = useAnimatedStyle(() => {
    const rotate = interpolate(animation.value, [0, 1], [0, 45]);
    return {
      transform: [{ rotate: `${rotate}deg` }],
    };
  });

  return (
    <View style={styles.container}>
      {/* Action Button 2: Magic/Wand */}
      <Animated.View style={[styles.floatingButtonView, action2Style]}>
        <Pressable 
          style={({ pressed }) => [
            styles.circleButton, 
            styles.glowGreen,
            pressed && styles.buttonPressed
          ]}
        >
          <Sparkles size={20} strokeWidth={2} color="#8EFF7A" />
        </Pressable>
      </Animated.View>

      {/* Action Button 1: Repository/List */}
      <Animated.View style={[styles.floatingButtonView, action1Style]}>
        <Pressable 
          style={({ pressed }) => [
            styles.circleButton, 
            styles.glowGreen,
            pressed && styles.buttonPressed
          ]}
        >
          <FolderGit2 size={20} strokeWidth={2} color="#8EFF7A" />
        </Pressable>
      </Animated.View>

      {/* Main Trigger Button: Plus */}
      <Animated.View style={[styles.mainButtonView, mainButtonStyle]}>
        <Pressable 
          onPress={toggleMenu}
          style={({ pressed }) => [
            styles.circleButton, 
            styles.glowGreen,
            styles.mainButton,
            pressed && styles.buttonPressed
          ]}
        >
          <Plus size={24} strokeWidth={2} color="#8EFF7A" />
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 90, // Positioned above the bottom navigation
    right: 24,
    alignItems: 'center',
    zIndex: 999,
  },
  floatingButtonView: {
    position: 'absolute',
  },
  mainButtonView: {
    zIndex: 10,
  },
  circleButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#0B0F0C',
    borderWidth: 1,
    borderColor: '#8EFF7A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mainButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
  },
  buttonPressed: {
    transform: [{ scale: 0.9 }],
    opacity: 0.85,
  },
  glowGreen: {
    shadowColor: '#8EFF7A',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
  },
});
