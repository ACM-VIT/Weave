import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Star, Clock, Bug } from 'lucide-react-native';
import type { RepositoryData } from '../../data/repositories';
import { EyeHomeIcon, GitForkHomeIcon } from './FeedIcons';

export function HomeUserFooter({
  repository,
  isSmallPhone,
  topGap,
}: {
  repository: RepositoryData;
  isSmallPhone?: boolean;
  topGap: number;
}) {
  const avatarSize = isSmallPhone ? 32 : 41;

  return (
    <View style={[styles.footer, { marginTop: topGap }, isSmallPhone && { paddingBottom: 10 }]}>
      <View style={[styles.avatar, { width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }, isSmallPhone && { marginRight: 8 }]} />
      <View style={styles.userMeta}>
        <Text style={[styles.username, isSmallPhone && { fontSize: 14, lineHeight: 18 }]}>{repository.owner}</Text>
        <View style={[styles.stats, isSmallPhone && { gap: 12, marginTop: 6 }]}>
          <View style={styles.statItem}>
            <Star size={isSmallPhone ? 14 : 16} color="#4ADE80" strokeWidth={1.8} />
            <Text style={[styles.statText, isSmallPhone && { fontSize: 10 }]}>{repository.stats.stars}</Text>
          </View>
          <View style={styles.statItem}>
            <EyeHomeIcon size={isSmallPhone ? 14 : 16} />
            <Text style={[styles.statText, isSmallPhone && { fontSize: 10 }]}>{repository.stats.views}</Text>
          </View>
          <View style={styles.statItem}>
            <GitForkHomeIcon size={isSmallPhone ? 14 : 16} />
            <Text style={[styles.statText, isSmallPhone && { fontSize: 10 }]}>{repository.stats.forks}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

export function UserFooter({ repository, isSmallPhone }: { repository: RepositoryData, isSmallPhone?: boolean }) {
  const avatarSize = isSmallPhone ? 32 : 41;

  return (
    <View style={[styles.footer, isSmallPhone && { marginTop: 16 }]}>
      <View style={[styles.avatar, { width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }, isSmallPhone && { marginRight: 8 }]} />
      <View style={styles.userMeta}>
        <Text style={[styles.username, isSmallPhone && { fontSize: 14, lineHeight: 18 }]}>{repository.owner}</Text>
        <View style={[styles.stats, isSmallPhone && { gap: 10, marginTop: 4 }]}>
          <View style={styles.statItem}>
            <Star size={isSmallPhone ? 14 : 16} color="#4ADE80" strokeWidth={1.8} />
            <Text style={[styles.statText, isSmallPhone && { fontSize: 10 }]}>{repository.stats.stars}</Text>
          </View>
          <View style={styles.statItem}>
            <EyeHomeIcon size={isSmallPhone ? 14 : 16} />
            <Text style={[styles.statText, isSmallPhone && { fontSize: 10 }]}>{repository.stats.views}</Text>
          </View>
          <View style={styles.statItem}>
            <Bug size={isSmallPhone ? 13 : 15} color="#4ADE80" strokeWidth={2} />
            <Text style={[styles.statText, isSmallPhone && { fontSize: 10 }]}>{repository.stats.bugs}</Text>
          </View>
        </View>
        <View style={[styles.dateRow, isSmallPhone && { marginTop: 4 }]}>
          <Clock size={isSmallPhone ? 10 : 14} color="#A49898" strokeWidth={1.6} />
          <Text style={[styles.dateText, isSmallPhone && { fontSize: 9 }]}>{repository.updatedText}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 0,
    marginTop: 28,
    paddingBottom: 8,
    width: '100%',
  },
  avatar: {
    width: 41,
    height: 41,
    borderRadius: 20.5,
    backgroundColor: '#75FF67',
    marginRight: 10,
  },
  userMeta: {
    flex: 1,
  },
  username: {
    color: '#FFFFFF',
    fontFamily: 'NataSans-Bold',
    fontSize: 16,
    lineHeight: 20,
  },
  stats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 6,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statText: {
    color: '#FFFFFF',
    fontFamily: 'NataSans-Regular',
    fontSize: 11,
    lineHeight: 14,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
  },
  dateText: {
    color: '#A49898',
    fontFamily: 'NataSans-Regular',
    fontSize: 11,
    lineHeight: 15,
  },
});
