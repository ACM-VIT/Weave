import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { LogOut, SquarePen } from 'lucide-react-native';

export type ProfileHeaderStat = { value: string; label: string; onPress: () => void };
type Props = {
  username: string;
  name: string;
  job: string;
  avatarUrl?: string | null;
  isTablet: boolean;
  isCompact: boolean;
  stats: ProfileHeaderStat[];
  onEdit: () => void;
  onChangePhoto?: () => void;
  onLogout: () => void;
};

function ProfileAvatar({ uri, letter, size, label, textSize }: { uri: string; letter: string; size: number; label: string; textSize: number }) {
  const [failed, setFailed] = useState(false);
  return <View style={[styles.avatar, { width: size, height: size }]}>
    {uri && !failed ? <Image accessibilityLabel={label} source={{ uri }} resizeMode="cover"
      onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: size / 2 }} />
      : <Text accessibilityLabel={label} className="font-nataBold" style={{ color: '#fff', fontSize: textSize }}>{letter}</Text>}
  </View>;
}

export function ProfileHeader({ username, name, job, avatarUrl, isTablet, isCompact, stats, onEdit, onLogout, onChangePhoto }: Props) {
  const avatarLetter = username.trim().charAt(0).toUpperCase() || name.trim().charAt(0).toUpperCase() || '?';
  const avatarSize = isTablet ? 96 : isCompact ? 68 : 80;
  const avatarUri = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
  return (
    <View style={styles.header}>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Log out" onPress={onLogout} style={styles.action}>
            <LogOut size={22} strokeWidth={1.9} color="#97969C" />
          </Pressable>
        </View>
      <View style={styles.topRow}>
        <View style={{ alignItems: 'center' }}>
          <ProfileAvatar key={avatarUri} uri={avatarUri} letter={avatarLetter} size={avatarSize}
            textSize={isTablet ? 38 : 32} label={`${name || username || 'Your'} profile photo`} />
          {onChangePhoto ? <Pressable accessibilityRole="button" accessibilityLabel="Change profile photo" onPress={onChangePhoto}
            style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 4 }}><Text style={{ color: '#63E08A', fontSize: 13 }}>Change photo</Text></Pressable> : null}
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
      <Pressable accessibilityRole="button" accessibilityLabel="Edit profile" onPress={onEdit}
        style={({ pressed }) => [styles.edit, pressed && { opacity: 0.75 }]}>
        <SquarePen size={22} strokeWidth={1.9} color="#F7F7F8" />
        <Text className="font-nataSemiBold" style={styles.editLabel}>Edit Profile</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { width: '100%', gap: 18 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  avatar: { flexShrink: 0, borderRadius: 999, backgroundColor: '#9B4FE4', alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', alignSelf: 'flex-end', flexShrink: 0, gap: 4 },
  action: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  edit: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, borderWidth: 1,
    borderColor: '#2F2F32', backgroundColor: '#1D1D1F', flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center' },
  editLabel: { color: '#F7F7F8', fontSize: 15, lineHeight: 22, flexShrink: 1 },
  identity: { flex: 1, minWidth: 0, gap: 5 },
  username: { color: '#8A898F', fontSize: 16, lineHeight: 22, flexShrink: 1 },
  name: { color: '#F7F7F8', fontSize: 22, lineHeight: 29 },
  bio: { color: '#8A898F', fontSize: 14, lineHeight: 21 },
  stats: { width: '100%', flexDirection: 'row', alignItems: 'stretch' },
  stat: { flex: 1, minWidth: 0, minHeight: 70, paddingVertical: 10, paddingHorizontal: 2, alignItems: 'center', justifyContent: 'flex-start', gap: 4, borderRadius: 10 },
  statValue: { color: '#fff', fontSize: 20, lineHeight: 26, fontVariant: ['tabular-nums'] },
  statLabel: { color: '#77767C', fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
