import { Redirect } from 'expo-router';

// The real Explore screen lives at src/app/(tabs)/explore.tsx
// This file exists only to satisfy any direct /explore navigation
export default function ExplorePage() {
  return <Redirect href="/(tabs)/explore" />;
}
