import { forwardRef } from 'react';
import { Platform, StyleSheet, type ScrollViewProps, type ViewProps } from 'react-native';
import { cssInterop } from 'nativewind';
import { KeyboardAwareScrollView, KeyboardAvoidingView, type KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

cssInterop(KeyboardAwareScrollView, { className: 'style' });

/** One scroll owner for forms. Do not nest in another keyboard avoider. */
export const KeyboardForm = forwardRef<KeyboardAwareScrollViewRef, ScrollViewProps & { safeArea?: boolean }>(
  function KeyboardForm({ contentContainerStyle, style, safeArea = true, ...props }, ref) {
    const insets = useSafeAreaInsets();
    const content = StyleSheet.flatten(contentContainerStyle);
    return <KeyboardAwareScrollView
      {...props}
      ref={ref}
      style={[{ flex: 1 }, style]}
      contentContainerStyle={[
        { flexGrow: 1 },
        contentContainerStyle,
        safeArea && {
          paddingTop: insets.top + Number(content?.paddingTop ?? content?.paddingVertical ?? content?.padding ?? 16),
          paddingBottom: insets.bottom + Number(content?.paddingBottom ?? content?.paddingVertical ?? content?.padding ?? 24),
        },
      ]}
      bottomOffset={16}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      keyboardShouldPersistTaps="handled"
      // Keyboard controller owns the keyboard inset; avoid applying it twice on iOS.
      automaticallyAdjustKeyboardInsets={false}
      contentInsetAdjustmentBehavior="never"
    />;
  },
);

/** For pinned search headers and sheet footers. Children must be able to shrink. */
export function KeyboardSurface({ style, ...props }: ViewProps) {
  return <KeyboardAvoidingView {...props} automaticOffset behavior="padding" style={[styles.surface, style]} />;
}

const styles = StyleSheet.create({ surface: { flex: 1, minHeight: 0 } });
