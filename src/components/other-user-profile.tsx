import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { ArrowLeft, List as ListIcon, Pin } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import RepoCard from '@/components/explore/RepoCard';
import { FollowButton } from '@/components/follow-button';
import { BoardListCard } from '@/components/profile/BoardListCard';
import { APP_THEME, REFERENCE_THEME } from '@/constants/theme';
import type { RepositoryDetail } from '@/models/repository';
import { getAvatarColor } from '@/utils/avatar-color';
import { formatCompactCount } from '@/utils/format-count';

export type OtherUserProfileData = {
  userId?: string;
  profileId?: string;
  username: string;
  displayName: string;
  bio?: string | null;
  avatarUrl?: string | null;
  isSelf?: boolean;
  isFollowing: boolean;
  followStateKnown?: boolean;
  stats: {
    likes: number;
    followers: number;
    following: number;
  };
  lists: {
    id: string;
    name: string;
    description?: string | null;
    repositoryCount: number;
  }[];
  pinnedRepositories: RepositoryDetail[];
};

type OtherUserProfileProps = {
  profile: OtherUserProfileData;
  loading?: boolean;
  followStateUpdatedAt?: number;
  onBack: () => void;
  onFollowersPress?: () => void;
  onFollowingPress?: () => void;
  onFollowError?: (error: Error) => void;
  onFollowingChange?: (following: boolean) => void;
  onListPress: (listId: string) => void;
  onRepositoryPress: (repository: RepositoryDetail) => void;
};

const PINNED_PREVIEW_LIMIT = 3;
const TAB_CONTROL_RADIUS = 13;
type ProfileTab = 'Lists' | 'Repositories';

function avatarInitial(profile: OtherUserProfileData) {
  return (profile.displayName.trim() || profile.username.trim() || '?').charAt(0).toUpperCase();
}

export function OtherUserProfile({
  profile,
  followStateUpdatedAt,
  loading = false,
  onBack,
  onFollowersPress,
  onFollowingPress,
  onFollowError,
  onFollowingChange,
  onListPress,
  onRepositoryPress,
}: OtherUserProfileProps) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = width < 360;
  const tablet = width >= 768;
  const [activeTab, setActiveTab] = useState<ProfileTab>('Repositories');
  const [showAllPinned, setShowAllPinned] = useState(false);
  const headerProgress = useMemo(() => new Animated.Value(0), []);
  const pinnedProgress = useMemo(() => new Animated.Value(0), []);
  const profileIdentifier = profile.profileId || profile.userId || profile.username;
  const avatarColor = useMemo(
    () => getAvatarColor(profileIdentifier),
    [profileIdentifier],
  );

  useEffect(() => {
    const animation = Animated.stagger(90, [
      Animated.timing(headerProgress, {
        duration: 360,
        easing: Easing.out(Easing.cubic),
        toValue: 1,
        useNativeDriver: true,
      }),
      Animated.timing(pinnedProgress, {
        duration: 360,
        easing: Easing.out(Easing.cubic),
        toValue: 1,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [headerProgress, pinnedProgress]);

  const visibleRepositories = useMemo(
    () => showAllPinned
      ? profile.pinnedRepositories
      : profile.pinnedRepositories.slice(0, PINNED_PREVIEW_LIMIT),
    [profile.pinnedRepositories, showAllPinned],
  );
  const hasMorePinned = profile.pinnedRepositories.length > PINNED_PREVIEW_LIMIT;
  const headerAnimation = {
    opacity: headerProgress,
    transform: [{
      translateY: headerProgress.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }),
    }],
  };
  const pinnedAnimation = {
    opacity: pinnedProgress,
    transform: [{
      translateY: pinnedProgress.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }),
    }],
  };
  const stats = [
    { label: 'Likes', value: profile.stats.likes },
    { label: 'Followers', value: profile.stats.followers, onPress: onFollowersPress },
    { label: 'Following', value: profile.stats.following, onPress: onFollowingPress },
  ];

  return (
    <View style={styles.screen}>
      <View style={[styles.content, { maxWidth: tablet ? 760 : 620 }]}>
        <View
          style={[
            styles.navigation,
            {
              paddingHorizontal: tablet ? 28 : 20,
              paddingTop: Math.max(insets.top, 16) + (tablet ? 14 : 6),
            },
          ]}
        >
          <Pressable cssInterop={false}
            accessibilityLabel="Go back"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onBack}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
          >
            <ArrowLeft color={REFERENCE_THEME.text} size={compact ? 23 : 27} strokeWidth={1.9} />
          </Pressable>
          <Text style={styles.navigationTitle}>Profile</Text>
          <View style={styles.navigationSpacer} />
        </View>

        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            {
              paddingHorizontal: tablet ? 36 : 24,
              paddingBottom: Math.max(insets.bottom, 24) + 28,
            },
          ]}
          contentInsetAdjustmentBehavior="never"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View style={[styles.profileContent, headerAnimation]}>
            <View style={[styles.profileHeader, compact && styles.profileHeaderCompact]}>
              <View
                style={[
                  styles.avatar,
                  compact && styles.avatarCompact,
                  tablet && styles.avatarTablet,
                  { backgroundColor: avatarColor },
                ]}
              >
                {profile.avatarUrl ? (
                  <Image
                    accessibilityLabel={`${profile.displayName}'s profile picture`}
                    resizeMode="cover"
                    source={{ uri: profile.avatarUrl }}
                    style={StyleSheet.absoluteFill}
                  />
                ) : (
                  <Text style={[styles.avatarInitial, compact && styles.avatarInitialCompact]}>
                    {avatarInitial(profile)}
                  </Text>
                )}
              </View>

              <View style={styles.identity}>
                <View style={styles.handleRow}>
                  <Text
                    numberOfLines={2}
                    selectable
                    style={[styles.displayName, compact && styles.displayNameCompact]}
                  >
                    {profile.displayName.trim() || profile.username.replace(/^@/, '')}
                  </Text>
                  {!profile.isSelf ? (
                    <FollowButton
                      accentColor={APP_THEME.primary}
                      compact={compact}
                      identityKey={profile.username}
                      isFollowing={profile.isFollowing}
                      stateUpdatedAt={followStateUpdatedAt}
                      onError={onFollowError}
                      onFollowingChange={onFollowingChange}
                      stateKnown={profile.followStateKnown ?? Boolean(profile.userId || profile.profileId)}
                      targetProfileId={profile.profileId}
                      targetUserId={profile.userId}
                    />
                  ) : null}
                </View>
                <Text numberOfLines={2} selectable style={[styles.handle, compact && styles.handleCompact]}>
                  @{profile.username.replace(/^@/, '')}
                </Text>
                {profile.bio ? (
                  <Text
                    numberOfLines={2}
                    selectable
                    style={[styles.bio, compact && styles.bioCompact]}
                  >
                    {profile.bio}
                  </Text>
                ) : null}
              </View>
            </View>

            {loading ? (
              <View accessibilityLiveRegion="polite" style={styles.loadingRow}>
                <ActivityIndicator color={APP_THEME.primary} size="small" />
                <Text style={styles.loadingText}>Refreshing profile…</Text>
              </View>
            ) : null}

            <View style={[styles.stats, compact && styles.statsCompact]}>
              {stats.map((stat) => {
                const body = (
                  <>
                    <Text style={[styles.statValue, compact && styles.statValueCompact]}>
                      {formatCompactCount(stat.value)}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[styles.statLabel, stat.onPress && styles.interactiveStatLabel]}
                    >
                      {stat.label}
                    </Text>
                  </>
                );

                return stat.onPress ? (
                  <Pressable cssInterop={false}
                    accessibilityLabel={`View ${stat.label.toLocaleLowerCase()}`}
                    accessibilityRole="button"
                    key={stat.label}
                    onPress={stat.onPress}
                    style={({ pressed }) => [styles.stat, pressed && styles.statPressed]}
                  >
                    {body}
                  </Pressable>
                ) : (
                  <View key={stat.label} style={styles.stat}>{body}</View>
                );
              })}
            </View>
          </Animated.View>

          <Animated.View style={[styles.tabSection, pinnedAnimation]}>
            <View style={styles.tabControl}>
              {(['Repositories', 'Lists'] as const).map((tab) => (
                <Pressable
                  accessibilityRole="tab"
                  aria-selected={activeTab === tab}
                  accessibilityState={{ selected: activeTab === tab }}
                  key={tab}
                  onPress={() => setActiveTab(tab)}
                  style={[
                    styles.tabButton,
                    compact && styles.tabButtonCompact,
                    activeTab === tab && styles.tabButtonActive,
                  ]}
                >
                  <Text style={[styles.tabLabel, activeTab === tab && styles.tabLabelActive]}>
                    {tab}
                  </Text>
                </Pressable>
              ))}
            </View>

            {activeTab === 'Lists' ? (
              profile.lists.length > 0 ? (
                <View style={styles.repositoryList}>
                  {profile.lists.map((list) => (
                    <BoardListCard
                      compact={compact}
                      description={list.description}
                      key={list.id}
                      name={list.name}
                      onPress={() => onListPress(list.id)}
                      repositoryCount={list.repositoryCount}
                    />
                  ))}
                </View>
              ) : (
                <View style={styles.emptyState}>
                  <View style={styles.emptyIcon}>
                    <ListIcon color={REFERENCE_THEME.textTertiary} size={28} strokeWidth={1.6} />
                  </View>
                  <Text style={styles.emptyTitle}>No public lists</Text>
                  <Text style={styles.emptyMessage}>
                    Lists this developer shares will appear here.
                  </Text>
                </View>
              )
            ) : (
              <View style={styles.repositoryTab}>
                <View style={styles.sectionHeading}>
                  <View style={styles.sectionTitleRow}>
                    <Pin color={APP_THEME.primary} size={17} strokeWidth={2} />
                    <Text style={styles.sectionTitle}>Pinned Repositories</Text>
                  </View>
                  {hasMorePinned ? (
                    <Pressable cssInterop={false}
                      accessibilityRole="button"
                      onPress={() => setShowAllPinned((current) => !current)}
                      style={({ pressed }) => [styles.viewAllButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.viewAllLabel}>{showAllPinned ? 'Show Less' : 'View All'}</Text>
                    </Pressable>
                  ) : null}
                </View>

                {visibleRepositories.length > 0 ? (
                  <View style={styles.repositoryList}>
                    {visibleRepositories.map((repository) => (
                      <View key={repository.id} style={styles.pinnedRepositoryCard}>
                        <RepoCard
                          compact={compact}
                          onPress={() => onRepositoryPress(repository)}
                          repo={repository}
                          variant="profile"
                        />
                        <View pointerEvents="none" style={styles.pinBadge}>
                          <Pin color={APP_THEME.primary} size={14} strokeWidth={2.1} />
                        </View>
                      </View>
                    ))}
                  </View>
                ) : (
                  <View style={styles.emptyState}>
                    <View style={styles.emptyIcon}>
                      <Pin color={REFERENCE_THEME.textTertiary} size={27} strokeWidth={1.6} />
                    </View>
                    <Text style={styles.emptyTitle}>No pinned repositories</Text>
                    <Text style={styles.emptyMessage}>
                      Repositories this developer pins will appear here.
                    </Text>
                  </View>
                )}
              </View>
            )}
          </Animated.View>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', backgroundColor: REFERENCE_THEME.background },
  content: { width: '100%', flex: 1 },
  navigation: { minHeight: 66, paddingBottom: 8, flexDirection: 'row', alignItems: 'center' },
  backButton: { width: 44, height: 44, alignItems: 'flex-start', justifyContent: 'center' },
  navigationTitle: { flex: 1, color: REFERENCE_THEME.text, fontFamily: 'NataSans-Bold', fontSize: 20, lineHeight: 25, textAlign: 'center' },
  navigationSpacer: { width: 44 },
  scrollContent: { flexGrow: 1, paddingTop: 18 },
  profileContent: { gap: 26 },
  profileHeader: { minHeight: 112, flexDirection: 'row', alignItems: 'center', gap: 24 },
  profileHeaderCompact: { minHeight: 82, gap: 14 },
  avatar: { width: 98, height: 98, flexShrink: 0, borderRadius: 49, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.2)' },
  avatarCompact: { width: 76, height: 76, borderRadius: 38 },
  avatarTablet: { width: 112, height: 112, borderRadius: 56 },
  avatarInitial: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-Bold', fontSize: 34, lineHeight: 41 },
  avatarInitialCompact: { fontSize: 27, lineHeight: 33 },
  identity: { flex: 1, minWidth: 0, justifyContent: 'center' },
  handleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  handle: { marginTop: 4, color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 15, lineHeight: 21 },
  handleCompact: { fontSize: 14, lineHeight: 20 },
  displayName: { flex: 1, minWidth: 0, color: REFERENCE_THEME.text, fontFamily: 'NataSans-Bold', fontSize: 22, lineHeight: 28 },
  displayNameCompact: { fontSize: 20, lineHeight: 26 },
  bio: { marginTop: 5, color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 15, lineHeight: 20 },
  bioCompact: { fontSize: 12, lineHeight: 16 },
  loadingRow: { minHeight: 22, marginTop: -10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  loadingText: { color: REFERENCE_THEME.textTertiary, fontFamily: 'NataSans-Regular', fontSize: 11.5 },
  stats: { width: '100%', maxWidth: 520, alignSelf: 'center', flexDirection: 'row', paddingVertical: 7, paddingHorizontal: 5, gap: 4 },
  statsCompact: { paddingVertical: 4 },
  stat: { flex: 1, minWidth: 0, minHeight: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 2 },
  statPressed: { backgroundColor: REFERENCE_THEME.control, opacity: 0.74 },
  statValue: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-Bold', fontSize: 19, lineHeight: 24, fontVariant: ['tabular-nums'] },
  statValueCompact: { fontSize: 16, lineHeight: 21 },
  statLabel: { color: REFERENCE_THEME.textTertiary, fontFamily: 'NataSans-Regular', fontSize: 12, lineHeight: 16 },
  interactiveStatLabel: { color: REFERENCE_THEME.textSecondary },
  tabSection: { marginTop: 34, gap: 22 },
  tabControl: { width: '100%', flexDirection: 'row', overflow: 'hidden', borderRadius: TAB_CONTROL_RADIUS, borderCurve: 'continuous', backgroundColor: '#151515', borderWidth: StyleSheet.hairlineWidth, borderColor: REFERENCE_THEME.separator },
  tabButton: { width: '50%', height: 48, alignItems: 'center', justifyContent: 'center' },
  tabButtonCompact: { height: 40 },
  tabButtonActive: { borderRadius: TAB_CONTROL_RADIUS, borderCurve: 'continuous', backgroundColor: APP_THEME.primary },
  tabLabel: { color: '#99989E', fontFamily: 'NataSans-SemiBold', fontSize: 14, lineHeight: 18 },
  tabLabelActive: { color: APP_THEME.primaryForeground },
  repositoryTab: { gap: 18 },
  sectionHeading: { minHeight: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  sectionTitleRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-Bold', fontSize: 17, lineHeight: 22, letterSpacing: -0.2 },
  viewAllButton: { minHeight: 34, borderRadius: 999, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1B211D', borderWidth: StyleSheet.hairlineWidth, borderColor: APP_THEME.primary },
  viewAllLabel: { color: APP_THEME.primary, fontFamily: 'NataSans-SemiBold', fontSize: 12, lineHeight: 16 },
  repositoryList: { gap: 11 },
  pinnedRepositoryCard: { position: 'relative' },
  pinBadge: { position: 'absolute', top: 11, right: 11, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#29292C', borderWidth: StyleSheet.hairlineWidth, borderColor: APP_THEME.primary },
  emptyState: { minHeight: 230, borderRadius: 22, borderCurve: 'continuous', paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: REFERENCE_THEME.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: REFERENCE_THEME.separator },
  emptyIcon: { width: 62, height: 62, marginBottom: 12, borderRadius: 31, alignItems: 'center', justifyContent: 'center', backgroundColor: REFERENCE_THEME.control },
  emptyTitle: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-SemiBold', fontSize: 16, lineHeight: 21, textAlign: 'center' },
  emptyMessage: { maxWidth: 310, marginTop: 6, color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
  pressed: { opacity: 0.7, transform: [{ scale: 0.97 }] },
});
