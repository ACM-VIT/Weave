import { Pressable, ScrollView, Text } from 'react-native';
import { SEARCH_GROUPS, type SearchGroup } from '@/models/search';

export default function SearchFilterTabs({ value, onChange }: { value: SearchGroup; onChange: (value: SearchGroup) => void }) {
  return <ScrollView horizontal contentContainerStyle={{ gap: 8, paddingHorizontal: 20, paddingVertical: 12 }}>
    {SEARCH_GROUPS.map(group => <Pressable key={group.id} accessibilityRole="tab" accessibilityState={{ selected: value === group.id }}
      onPress={() => onChange(group.id)} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 18, borderRadius: 24,
        alignItems: 'center', justifyContent: 'center', backgroundColor: value === group.id ? '#FFFFFF' : '#272729', opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ color: value === group.id ? '#000000' : '#FFFFFF', fontSize: 15, fontWeight: '600' }}>{group.label}</Text>
    </Pressable>)}
  </ScrollView>;
}
