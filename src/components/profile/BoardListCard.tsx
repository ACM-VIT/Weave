import { ChevronRight, FolderOpen, Pin } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export type BoardListCardProps = {
  name: string;
  description?: string | null;
  repositoryCount: number;
  onPress: () => void;
  compact?: boolean;
  variant?: 'board' | 'pinned';
};

export function BoardListCard({
  name,
  description,
  repositoryCount,
  onPress,
  compact = false,
  variant = 'board',
}: BoardListCardProps) {
  const [hovered, setHovered] = useState(false);
  const count = Math.max(0, Number(repositoryCount) || 0);
  const countLabel = `${count} ${count === 1 ? 'repository' : 'repositories'}`;

  return (
    <Pressable
      accessibilityHint="Opens the repositories saved in this list"
      accessibilityLabel={`${name}, ${countLabel}`}
      accessibilityRole="button"
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        compact ? styles.cardCompact : styles.cardRegular,
        hovered && styles.cardHovered,
        pressed && styles.cardPressed,
      ]}
    >
      <View style={[styles.cover, compact && styles.coverCompact]}>
        {variant === 'pinned' ? (
          <Pin color="#63E08A" size={compact ? 18 : 22} strokeWidth={1.9} />
        ) : (
          <FolderOpen color="#63E08A" size={compact ? 19 : 23} strokeWidth={1.8} />
        )}
      </View>

      <View style={styles.copy}>
        <Text numberOfLines={1} style={[styles.name, compact && styles.nameCompact]}>
          {name}
        </Text>
        {description ? (
          <Text numberOfLines={2} style={[styles.description, compact && styles.descriptionCompact]}>
            {description}
          </Text>
        ) : null}
        <Text style={[styles.count, compact && styles.countCompact]}>{countLabel}</Text>
      </View>

      <ChevronRight color="#5D5C62" size={compact ? 17 : 20} strokeWidth={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    borderCurve: 'continuous',
    backgroundColor: '#151515',
    gap: 13,
  },
  cardRegular: {
    minHeight: 84,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  cardCompact: {
    minHeight: 70,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  cardPressed: {
    opacity: 0.72,
    transform: [{ scale: 0.992 }],
  },
  cardHovered: {
    backgroundColor: '#1B1B1B',
  },
  cover: {
    width: 48,
    height: 48,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: '#222622',
    borderColor: '#2D392F',
    borderWidth: StyleSheet.hairlineWidth,
  },
  coverCompact: {
    width: 42,
    height: 42,
    borderRadius: 12,
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  name: {
    color: '#F7F7F8',
    fontFamily: 'NataSans-SemiBold',
    fontSize: 16,
    lineHeight: 21,
  },
  nameCompact: {
    fontSize: 14,
    lineHeight: 18,
  },
  description: {
    color: '#858489',
    fontFamily: 'NataSans-Regular',
    fontSize: 12,
    lineHeight: 17,
  },
  descriptionCompact: {
    fontSize: 11,
    lineHeight: 15,
  },
  count: {
    color: '#63E08A',
    fontFamily: 'NataSans-Medium',
    fontSize: 11,
    lineHeight: 15,
  },
  countCompact: {
    fontSize: 10,
    lineHeight: 14,
  },
});
