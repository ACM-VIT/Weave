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
  onGitHubPreferences?: () => void;
  githubPreferencesVisible?: boolean;
  githubIcon?: React.ReactNode;
};

function ProfileAvatar({ uri, letter, size, label, textSize }: { uri: string; letter: string; size: number; label: string; textSize: number }) {
  const [failed, setFailed] = useState(false);
  return <View style={[styles.avatar, { width: size, height: size }]}>
    {uri && !failed ? <Image accessibilityLabel={label} source={{ uri }} resizeMode="cover"
      onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: size / 2 }} />
      : <Text accessibilityLabel={label} className="font-nataBold" style={{ color: '#fff', fontSize: textSize }}>{letter}</Text>}
  </View>;
}

export function ProfileHeader({ username, name, job, avatarUrl, isTablet, isCompact, stats, onEdit, onLogout, onChangePhoto, onGitHubPreferences, githubPreferencesVisible, githubIcon }: Props) {
  const avatarLetter = username.trim().charAt(0).toUpperCase() || name.trim().charAt(0).toUpperCase() || '?';
  const avatarSize = isTablet ? 80 : isCompact ? 56 : 64;
  const avatarUri = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
  const avatar = <ProfileAvatar key={avatarUri} uri={avatarUri} letter={avatarLetter} size={avatarSize}
    textSize={isTablet ? 32 : 26} label={`${name || username || 'Your'} profile photo`} />;
  return (
    <View style={styles.header}>
      <View style={styles.topRow}>
        {onChangePhoto ? <Pressable accessibilityRole="button" accessibilityLabel="Change profile photo"
          onPress={onChangePhoto} style={{ flexShrink: 0, minWidth: 48, minHeight: 48 }}>{avatar}</Pressable> : avatar}
        <View style={styles.identity}>
          {name ? <Text selectable numberOfLines={2} className="font-nataBold" style={styles.name}>{name}</Text> : null}
          {username ? <Text selectable numberOfLines={2} className="font-nata" style={styles.username}>@{username}</Text> : null}
        </View>
        <View style={styles.actions}>
            {onGitHubPreferences ? <Pressable accessibilityRole="button" accessibilityLabel="GitHub activity preferences"
              accessibilityHint="Opens GitHub activity and account settings" accessibilityState={{ expanded: githubPreferencesVisible }}
              onPress={onGitHubPreferences} style={styles.action}>
              <View style={styles.githubSquare}>{githubIcon}</View>
            </Pressable> : null}
            <Pressable accessibilityRole="button" accessibilityLabel="Log out" onPress={onLogout} style={styles.action}>
              <LogOut size={22} strokeWidth={1.9} color="#97969C" />
            </Pressable>
        </View>
      </View>
      {job ? <Text numberOfLines={4} className="font-nata" style={styles.bio}>{job}</Text> : null}
      <View style={styles.stats}>
        {stats.map(stat => (
          <Pressable cssInterop={false} key={stat.label} accessibilityRole="button" accessibilityLabel={`${stat.value} ${stat.label}`} onPress={stat.onPress}
            style={({ pressed }) => [styles.stat, { backgroundColor: pressed ? '#171717' : 'transparent' }]}>
            <Text className="font-nataBold" style={styles.statValue}>{stat.value}</Text>
            <Text className="font-nata" style={styles.statLabel}>{stat.label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable cssInterop={false} accessibilityRole="button" accessibilityLabel="Edit profile" onPress={onEdit}
        style={({ pressed }) => [styles.edit, pressed && { opacity: 0.75 }]}>
        <SquarePen size={22} strokeWidth={1.9} color="#F7F7F8" />
        <Text className="font-nataSemiBold" style={styles.editLabel}>Edit Profile</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { width: '100%', gap: 18 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { flexShrink: 0, borderRadius: 999, backgroundColor: '#9B4FE4', alignItems: 'center', justifyContent: 'center' },
  action: { width: 48, height: 48, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  githubSquare: { width: 36, height: 36, borderRadius: 10, borderWidth: 1, borderColor: '#2F2F32', backgroundColor: '#63E08A18', alignItems: 'center', justifyContent: 'center' },
  edit: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, borderWidth: 1,
    borderColor: '#2F2F32', backgroundColor: '#1D1D1F', flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center' },
  editLabel: { color: '#F7F7F8', fontSize: 15, lineHeight: 22, flexShrink: 1 },
  identity: { flex: 1, minWidth: 0, gap: 5 },
  actions: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  username: { color: '#8A898F', fontSize: 16, lineHeight: 22, flexShrink: 1 },
  name: { color: '#F7F7F8', fontSize: 20, lineHeight: 26 },
  bio: { color: '#8A898F', fontSize: 14, lineHeight: 21 },
  stats: { width: '100%', flexDirection: 'row', alignItems: 'stretch' },
  stat: { flex: 1, minWidth: 0, minHeight: 70, paddingVertical: 10, paddingHorizontal: 2, alignItems: 'center', justifyContent: 'flex-start', gap: 4, borderRadius: 10 },
  statValue: { color: '#fff', fontSize: 20, lineHeight: 26, fontVariant: ['tabular-nums'] },
  statLabel: { color: '#77767C', fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
