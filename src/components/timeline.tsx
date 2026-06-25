import React from 'react';
import { StyleSheet, View } from 'react-native';

// Header timeline: renders the top green dot + the vertical line connecting down to the card column.
// The vertical spine sits at left = 28px within this 52px-wide component, matching the inline rail.
export function HeaderTimeline() {
  return (
    <View style={styles.headerRoot}>
      {/* Top filled dot (Github_Social marker) */}
      <View style={styles.topDot} />
      {/* Vertical line connecting from below the dot downward */}
      <View style={styles.headerLine} />
    </View>
  );
}

const styles = StyleSheet.create({
  headerRoot: {
    width: 52,
    height: 52,
    position: 'relative',
  },
  topDot: {
    position: 'absolute',
    top: 2,
    left: 21,      // centers a 10px dot at x = 26 ≈ 28 center
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#6DA963',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    zIndex: 3,
  },
  headerLine: {
    position: 'absolute',
    top: 11,       // starts just below the dot
    left: 27,      // center of 1.5px line at x = 28
    bottom: 0,
    width: 1.5,
    backgroundColor: '#6DA963',
    zIndex: 1,
  },
});
