import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FolderGit2 } from 'lucide-react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { APP_THEME, REFERENCE_THEME } from '@/constants/theme';
import type { RepositoryDetail } from '@/models/repository';
import { getAvatarColor } from '@/utils/avatar-color';
import { formatCompactCount } from '@/utils/format-count';
import { README_SUMMARY_PENDING } from '@/utils/readme';

interface RepoCardProps {
  repo: RepositoryDetail;
  onPress?: () => void;
  showMetrics?: boolean;
  variant?: 'default' | 'profile';
  compact?: boolean;
}

function StarIcon(): React.JSX.Element {
  return (
    <Svg width={11} height={11} viewBox="0 0 24 24" fill="#FFD60A">
      <Path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2Z" />
    </Svg>
  );
}

function ForkIcon(): React.JSX.Element {
  return (
    <Svg width={11} height={11} viewBox="0 0 24 24" fill="none">
      <Circle cx={6} cy={4.5} r={2.3} stroke="rgba(235,235,245,0.55)" strokeWidth={2} />
      <Circle cx={18} cy={4.5} r={2.3} stroke="rgba(235,235,245,0.55)" strokeWidth={2} />
      <Circle cx={12} cy={19.5} r={2.3} stroke="rgba(235,235,245,0.55)" strokeWidth={2} />
      <Path
        d="M6 7v1.5A3.5 3.5 0 0 0 9.5 12h5A3.5 3.5 0 0 0 18 8.5V7M12 12v5"
        stroke="rgba(235,235,245,0.55)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function GradientAvatar({ repo }: { repo: RepositoryDetail }): React.JSX.Element {
  const color = getAvatarColor(repo.fullName);

  return (
    <View style={{ width: 20, height: 20 }}>
      <Svg width={20} height={20} viewBox="0 0 20 20">
        <Defs>
          <LinearGradient id={`avatar-${repo.id}`} x1="3" y1="2" x2="17" y2="18" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={color} />
            <Stop offset="1" stopColor={APP_THEME.primary} />
          </LinearGradient>
        </Defs>
        <Circle cx={10} cy={10} r={10} fill={`url(#avatar-${repo.id})`} />
      </Svg>
      <View
        style={{
          position: 'absolute',
          inset: 0,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: '#FFFFFF', fontSize: 8, fontWeight: '700' }}>{repo.owner.slice(0, 2).toUpperCase()}</Text>
      </View>
    </View>
  );
}

export default function RepoCard({
  repo,
  onPress,
  showMetrics = true,
  variant = 'default',
  compact = false,
}: RepoCardProps): React.JSX.Element {
  const cardSummary = repo.readmeSummary || repo.description || README_SUMMARY_PENDING;
  if (variant === 'profile') {
    return (
      <Pressable cssInterop={false}
        accessibilityHint="Opens this repository"
        accessibilityLabel={`Open ${repo.name} by ${repo.owner}`}
        accessibilityRole="link"
        onPress={onPress}
        style={({ pressed }) => [
          styles.profileCard,
          compact && styles.profileCardCompact,
          pressed && styles.profileCardPressed,
        ]}
      >
        <View style={styles.profileCardHeader}>
          <View style={[styles.repositoryIcon, compact && styles.repositoryIconCompact]}>
            <FolderGit2
              color={APP_THEME.primary}
              size={compact ? 18 : 21}
              strokeWidth={1.8}
            />
          </View>
          <View style={styles.profileCardCopy}>
            <Text
              numberOfLines={1}
              style={[styles.profileCardName, compact && styles.profileCardNameCompact]}
            >
              {repo.name}
            </Text>
            {cardSummary ? (
              <Text
                numberOfLines={compact ? 2 : 3}
                style={[
                  styles.profileCardDescription,
                  compact && styles.profileCardDescriptionCompact,
                ]}
              >
                {cardSummary}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.profileCardFooter}>
          <Text numberOfLines={1} style={styles.profileCardAuthor}>
            {repo.owner}
          </Text>
          {showMetrics ? (
            <View style={styles.profileCardMetrics}>
              <View style={styles.profileCardMetric}>
                <StarIcon />
                <Text style={styles.profileCardMetricText}>{formatCompactCount(repo.stats.stars)}</Text>
              </View>
              <View style={styles.profileCardMetric}>
                <ForkIcon />
                <Text style={styles.profileCardMetricText}>{formatCompactCount(repo.stats.forks)}</Text>
              </View>
            </View>
          ) : null}
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityHint="Opens this repository"
      accessibilityLabel={`Open ${repo.name} by ${repo.owner}`}
      accessibilityRole="link"
      onPress={onPress}
      style={{
        borderRadius: 16,
        backgroundColor: '#1C1C1E',
        padding: 14,
      }}
    >
      <Text
        style={{
          color: '#FFFFFF',
          fontSize: 14,
          fontWeight: '600',
          letterSpacing: 0,
          lineHeight: 18.9,
        }}
      >
        {repo.name}
      </Text>
      <Text
        ellipsizeMode="tail"
        numberOfLines={4}
        style={{
          color: 'rgba(235, 235, 245, 0.55)',
          fontSize: 11.5,
          lineHeight: 16.675,
          marginTop: 5,
        }}
      >
        {cardSummary}
      </Text>
      {showMetrics ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <StarIcon />
            <Text style={{ color: 'rgba(235, 235, 245, 0.55)', fontSize: 11.5, fontWeight: '500' }}>{formatCompactCount(repo.stats.stars)}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <ForkIcon />
            <Text style={{ color: 'rgba(235, 235, 245, 0.55)', fontSize: 11.5, fontWeight: '500' }}>{formatCompactCount(repo.stats.forks)}</Text>
          </View>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 11 }}>
        <GradientAvatar repo={repo} />
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, flexShrink: 1, color: 'rgba(235, 235, 245, 0.6)', fontSize: 12, fontWeight: '500' }}>{repo.owner}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  profileCard: {
    width: '100%',
    height: 136,
    overflow: 'hidden',
    borderRadius: 17,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 13,
    justifyContent: 'space-between',
    backgroundColor: REFERENCE_THEME.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: REFERENCE_THEME.separator,
  },
  profileCardCompact: {
    height: 122,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  profileCardPressed: {
    opacity: 0.76,
    transform: [{ scale: 0.992 }],
  },
  profileCardHeader: {
    minHeight: 0,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
  },
  repositoryIcon: {
    width: 42,
    height: 42,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderCurve: 'continuous',
    backgroundColor: '#29292C',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: REFERENCE_THEME.border,
  },
  repositoryIconCompact: {
    width: 38,
    height: 38,
    borderRadius: 11,
  },
  profileCardCopy: {
    minWidth: 0,
    flex: 1,
    paddingRight: 30,
  },
  profileCardName: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.1,
  },
  profileCardNameCompact: {
    fontSize: 13.5,
    lineHeight: 18,
  },
  profileCardDescription: {
    marginTop: 4,
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-Regular',
    fontSize: 11.5,
    lineHeight: 16,
  },
  profileCardDescriptionCompact: {
    fontSize: 10.5,
    lineHeight: 14,
  },
  profileCardFooter: {
    minHeight: 20,
    marginTop: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  profileCardAuthor: {
    minWidth: 0,
    flex: 1,
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-Medium',
    fontSize: 11.5,
    lineHeight: 16,
  },
  profileCardMetrics: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  profileCardMetric: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  profileCardMetricText: {
    color: REFERENCE_THEME.textTertiary,
    fontFamily: 'NataSans-Medium',
    fontSize: 10.5,
    lineHeight: 14,
  },
});
