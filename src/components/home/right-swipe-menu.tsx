import React from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView } from 'react-native';
import { Bookmark, Share, Copy, ExternalLink, Flag, PlusCircle, MinusCircle, X } from 'lucide-react-native';
import { colors, fonts } from '@/constants/colors';
import type { Repository } from '@/types/repository';

interface RightSwipeMenuProps {
  repository: Repository;
  onClose: () => void;
  onSaveRepository?: () => void;
}

export function RightSwipeMenu({ repository, onClose, onSaveRepository }: RightSwipeMenuProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerTextContainer}>
          <Text style={styles.title}>Actions</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{repository.title}</Text>
        </View>
        <Pressable onPress={onClose} style={styles.closeButton} accessibilityLabel="Close menu">
          <X size={24} color="#A49898" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <MenuButton icon={<PlusCircle size={22} color={colors.white} />} label="Save Repository" onPress={onSaveRepository} />
        <MenuButton icon={<MinusCircle size={22} color={colors.white} />} label="Unsave Repository" />
        <MenuButton icon={<Bookmark size={22} color={colors.white} />} label="Bookmark" />
        <MenuButton icon={<Share size={22} color={colors.white} />} label="Share" />
        <MenuButton icon={<Copy size={22} color={colors.white} />} label="Copy Repository Link" />
        <MenuButton icon={<ExternalLink size={22} color={colors.white} />} label="Open Repository" />
        <MenuButton icon={<Flag size={22} color="#F5C54D" />} label="Report" labelColor="#F5C54D" />
      </ScrollView>
    </View>
  );
}

function MenuButton({ icon, label, labelColor = colors.white, onPress }: { icon: React.ReactNode, label: string, labelColor?: string, onPress?: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuButton,
        pressed && styles.menuButtonPressed,
      ]}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <View style={styles.iconContainer}>{icon}</View>
      <Text style={[styles.menuButtonText, { color: labelColor }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 60, // Safe area top approx
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
    borderBottomWidth: 1,
    borderBottomColor: '#273126',
    paddingBottom: 16,
  },
  headerTextContainer: {
    flex: 1,
    marginRight: 12,
  },
  title: {
    color: colors.white,
    fontFamily: fonts.bold,
    fontSize: 22,
    lineHeight: 28,
  },
  subtitle: {
    color: '#D9D9D9',
    fontFamily: fonts.regular,
    fontSize: 14,
    marginTop: 4,
  },
  closeButton: {
    padding: 4,
  },
  scrollContent: {
    gap: 8,
    paddingBottom: 40,
  },
  menuButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 12,
    backgroundColor: '#1C1C1C',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#273126',
  },
  menuButtonPressed: {
    backgroundColor: '#252E24',
    borderColor: colors.accent,
  },
  iconContainer: {
    width: 32,
    alignItems: 'center',
    marginRight: 12,
  },
  menuButtonText: {
    fontFamily: fonts.medium,
    fontSize: 16,
  },
});
