import { Pressable, Text, View } from 'react-native';
import { SEARCH_GROUPS, type SearchGroup } from '@/models/search';

export default function SearchFilterTabs({ value, onChange }: { value: SearchGroup; onChange: (value: SearchGroup) => void }) {
  return <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10 }}>
    <View style={{ flexDirection: 'row', backgroundColor: 'rgba(118,118,128,0.18)', borderRadius: 9, padding: 2 }}>
      {SEARCH_GROUPS.map(group => <Pressable cssInterop={false} key={group.id} accessibilityRole="tab" accessibilityLabel={group.label} accessibilityState={{ selected: value === group.id }}
        onPress={() => onChange(group.id)} style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: 4, borderRadius: 7,
          alignItems: 'center', justifyContent: 'center', backgroundColor: value === group.id ? 'rgb(99,99,102)' : 'transparent', opacity: pressed ? 0.7 : 1 })}>
        <Text numberOfLines={1} style={{ color: value === group.id ? '#FFFFFF' : 'rgba(235,235,245,0.6)', fontSize: 13, fontWeight: '600' }}>{group.id === 'repositories' ? 'Repos' : group.label}</Text>
      </Pressable>)}
    </View>
  </View>;
}
