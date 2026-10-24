import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LogOut, SquarePen } from 'lucide-react-native';

export type ProfileHeaderStat = { value: string; label: string; onPress: () => void };
type Props = {
  username: string;
  name: string;
  job: string;
  isTablet: boolean;
  isCompact: boolean;
  stats: ProfileHeaderStat[];
  onEdit: () => void;
  onLogout: () => void;
};

export function ProfileHeader({ username, name, job, isTablet, isCompact, stats, onEdit, onLogout }: Props) {
  const avatarLetter = username.trim().charAt(0).toUpperCase() || name.trim().charAt(0).toUpperCase() || '?';
  const avatarSize = isTablet ? 96 : isCompact ? 68 : 80;
  return (
    <View style={styles.header}>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Edit profile" onPress={onEdit} style={styles.action}>
            <SquarePen size={22} color="#97969C" />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Log out" onPress={onLogout} style={styles.action}>
            <LogOut size={24} color="#97969C" />
          </Pressable>
        </View>
      <View style={styles.topRow}>
        <View style={[styles.avatar, { width: avatarSize, height: avatarSize }]}>
          <Text className="font-nataBold" style={{ color: '#fff', fontSize: isTablet ? 38 : 32 }}>{avatarLetter}</Text>
        </View>
        <View style={styles.identity}>
          {name ? <Text selectable className="font-nataBold" style={styles.name}>{name}</Text> : null}
          {username ? <Text selectable numberOfLines={2} className="font-nata" style={styles.username}>@{username}</Text> : null}
        </View>
      </View>
      {job ? <Text numberOfLines={4} className="font-nata" style={styles.bio}>{job}</Text> : null}
      <View style={styles.stats}>
        {stats.map(stat => (
          <Pressable key={stat.label} accessibilityRole="button" accessibilityLabel={`${stat.value} ${stat.label}`} onPress={stat.onPress}
            style={({ pressed }) => [styles.stat, { backgroundColor: pressed ? '#171717' : 'transparent' }]}>
            <Text className="font-nataBold" style={styles.statValue}>{stat.value}</Text>
            <Text className="font-nata" style={styles.statLabel}>{stat.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { width: '100%', gap: 18 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  avatar: { flexShrink: 0, borderRadius: 999, backgroundColor: '#9B4FE4', alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', alignSelf: 'flex-end', flexShrink: 0, gap: 4 },
  action: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  identity: { flex: 1, minWidth: 0, gap: 5 },
  username: { color: '#8A898F', fontSize: 16, lineHeight: 22, flexShrink: 1 },
  name: { color: '#F7F7F8', fontSize: 22, lineHeight: 29 },
  bio: { color: '#8A898F', fontSize: 14, lineHeight: 21 },
  stats: { width: '100%', flexDirection: 'row', alignItems: 'stretch' },
  stat: { flex: 1, minWidth: 0, minHeight: 70, paddingVertical: 10, paddingHorizontal: 2, alignItems: 'center', justifyContent: 'flex-start', gap: 4, borderRadius: 10 },
  statValue: { color: '#fff', fontSize: 20, lineHeight: 26, fontVariant: ['tabular-nums'] },
  statLabel: { color: '#77767C', fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
