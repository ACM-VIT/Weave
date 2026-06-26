import { version } from 'expo/package.json';
import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

export function WebBadge() {
  return (
    <ThemedView className="p-8 items-center gap-2">
      <ThemedText type="code" themeColor="textSecondary" className="text-center">
        Expo v{version}
      </ThemedText>
    </ThemedView>
  );
}
