import { repositoryPreview } from '@/services/repositoryPreview';
import { useRepositoryReadmeSummary } from '@/hooks/use-repository-readme-summary';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {authSessionLifecycle} from '@/api/session-lifecycle';
import {takeFeedNavigation,type FeedNavigationAttribution} from '@/services/feedImpressionAttribution';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Bookmark,
  BookOpen,
  CircleAlert,
  ExternalLink,
  Eye,
  GitFork,
  Share2,
  Star,
  ThumbsUp,
} from 'lucide-react-native';

import {
  fetchRepositoryDetail,
  repositoryDetailQueryKey,
} from '@/api/repositories';
import { ReadmePopup } from '@/components/home/ReadmePopup';
import { SavePopup } from '@/components/home/save-popup';
import { ShareRepositorySheet } from '@/components/home/share-repository-sheet';
import { REFERENCE_THEME } from '@/constants/theme';
import type { RepositoryDetail } from '@/models/repository';
import { queueActivityForViewer } from '@/services/activityOutboxClient';
import { useAuth } from '@/store/AuthContext';
import { formatCompactCount } from '@/utils/format-count';
import { prepareReadmePreview, prepareReadmeSummaryDocument } from '@/utils/readme';
import { getStorageItem } from '@/utils/storage';

type ActionProps = {
  accessibilityLabel: string;
  active?: boolean;
  icon: typeof Bookmark;
  label: string;
  onPress: () => void;
};

function DetailAction({
  accessibilityLabel,
  active = false,
  icon: Icon,
  label,
  onPress,
}: ActionProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        active && styles.actionActive,
        pressed && styles.pressed,
      ]}
    >
      <Icon
        color={active ? '#07130A' : REFERENCE_THEME.text}
        fill={active && Icon === Bookmark ? '#07130A' : 'none'}
        size={19}
        strokeWidth={2}
      />
      <Text style={[styles.actionLabel, active && styles.actionLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function Stat({ icon: Icon, label, value }: {
  icon: typeof Star;
  label: string;
  value: number | string;
}) {
  return (
    <View accessible accessibilityLabel={`${formatCompactCount(Number(value))} ${label}`} style={styles.stat}>
      <Icon color={REFERENCE_THEME.textSecondary} size={17} strokeWidth={1.9} />
      <Text style={styles.statValue}>{formatCompactCount(Number(value))}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/(tabs)/home');
}

export function RepositoryDetailScreen({ repositoryId,navigationToken }: { repositoryId: string;navigationToken?:string }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { user, isLoading: isAuthLoading } = useAuth();
  const viewerUserId = user?.user_id;
  const queryClient = useQueryClient();
  const renderGeneration=authSessionLifecycle.currentGeneration();
  const [origin,setOrigin]=useState<FeedNavigationAttribution|null>(null);
  const consumedOrigin=useRef('');
  useEffect(()=>{
    const key=`${viewerUserId??''}:${repositoryId}:${navigationToken??''}:${renderGeneration}`;
    if(consumedOrigin.current===key)return;consumedOrigin.current=key;
    setOrigin(viewerUserId?takeFeedNavigation(queryClient,viewerUserId,repositoryId,navigationToken,renderGeneration):null);
  },[navigationToken,queryClient,renderGeneration,repositoryId,viewerUserId]);
  const attribution=origin&&origin.ownerId===viewerUserId&&origin.repoId===repositoryId&&origin.generation===renderGeneration?origin:null;

  const membershipScope = `${viewerUserId ?? ''}:${repositoryId}:${renderGeneration}`;
  const currentMembershipScope = useRef(membershipScope);
  useLayoutEffect(() => { currentMembershipScope.current = membershipScope; }, [membershipScope]);
  const [confirmedMembership, setConfirmedMembership] = useState<{scope: string; listIds: string[]; saved: boolean} | null>(null);

  const [saveVisible, setSaveVisible] = useState(false);
  const [shareVisible, setShareVisible] = useState(false);
  const [readmeVisible, setReadmeVisible] = useState(false);
  const [summaryVisible, setSummaryVisible] = useState(false);

  const repositoryQuery = useQuery<RepositoryDetail>({
    queryKey: repositoryDetailQueryKey(repositoryId, viewerUserId),
    enabled: Boolean(repositoryId && viewerUserId),
    queryFn: async ({ signal }) => {
      const token = await getStorageItem('access_token');
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      return fetchRepositoryDetail(repositoryId, token, signal);
    },
    staleTime: 60_000,
    retry: (failures, error) => ![401,403,404,410].includes((error as {status?:number}).status ?? 0) && failures < 1,
    placeholderData: () => repositoryPreview(queryClient, viewerUserId, repositoryId),
  });

  const terminalDetailError = repositoryQuery.isError && [401,403,404,410].includes((repositoryQuery.error as {status?:number})?.status ?? 0);
  const preview = terminalDetailError ? undefined : repositoryPreview(queryClient, viewerUserId, repositoryId);
  const partialDetail = repositoryQuery.isPlaceholderData || Boolean(!repositoryQuery.data && preview);
  const detail = terminalDetailError ? undefined : repositoryQuery.data ?? preview;
  const repository = useMemo(() => detail && partialDetail && confirmedMembership?.scope === membershipScope
    ? {...detail, selectedListIds: confirmedMembership.listIds, viewerSaved: confirmedMembership.saved}
    : detail, [confirmedMembership, detail, membershipScope, partialDetail]);
  const summaryQuery = useRepositoryReadmeSummary(repository);
  const contentWidth = Math.min(Math.max(width - 32, 0), 720);
  const preparedSummary = prepareReadmePreview({
    digest:summaryQuery.digest,summary:repository?.readmeSummary,description:repository?.description,
    fullReadme:repository?.readmeFull,summarySource:repository?.summarySource,
  });
  const summary = preparedSummary.source==='summary' ? summaryQuery.digest?.overview || preparedSummary.markdown
    : summaryQuery.isError ? 'Couldn’t load the README summary.'
      : ['pending','processing'].includes(summaryQuery.data?.status??'') ? 'Preparing README summary…'
        : summaryQuery.isLoading ? 'Loading README summary…' : preparedSummary.markdown;
  const languages = useMemo(() => repository?.languages ?? [], [repository?.languages]);

  const readmeSource = useMemo(() => ({
    fullName: repository?.fullName ?? '', githubUrl: repository?.githubUrl ?? '',
    readmeBaseUrl: repository?.readmeBaseUrl, readmeDefaultBranch: repository?.readmeDefaultBranch,
    readmeSourcePath: repository?.readmeSourcePath,
  }), [repository?.fullName, repository?.githubUrl, repository?.readmeBaseUrl,
    repository?.readmeDefaultBranch, repository?.readmeSourcePath]);

  const queueActivity = useCallback(async (action: 'share' | 'github_open') => {
    if (!viewerUserId || !repository || !authSessionLifecycle.isCurrent(renderGeneration)) return;
    await queueActivityForViewer(viewerUserId, { repo_id: repository.id, action,
      ...(attribution?{session_id:attribution.sessionId,serve_id:attribution.serveId,position:attribution.position,
        ...(attribution.original?{impression_event_id:attribution.original.eventId}:{})}:{}),
    });
  }, [attribution,renderGeneration,repository, viewerUserId]);

  const handleListMembershipsChanged = useCallback((listIds: string[], saved: boolean) => {
    if (!viewerUserId || currentMembershipScope.current !== membershipScope || !authSessionLifecycle.isCurrent(renderGeneration)) return;
    setConfirmedMembership({scope: membershipScope, listIds: [...listIds], saved});
    queryClient.setQueryData<RepositoryDetail>(
      repositoryDetailQueryKey(repositoryId, viewerUserId),
      (current) => current
        ? { ...current, selectedListIds: listIds, viewerSaved: saved }
        : current,
    );
  }, [membershipScope, queryClient, renderGeneration, repositoryId, viewerUserId]);

  const openGithub = useCallback(async () => {
    if (!repository) return;
    try {
      await Linking.openURL(repository.githubUrl);
      await queueActivity('github_open').catch(() => undefined);
    } catch {
      Alert.alert('Unable to open GitHub', 'Please try again in a moment.');
    }
  }, [queueActivity, repository]);

  if (!repositoryId) {
    return (
      <View style={[styles.stateScreen, { paddingTop: insets.top }]}>
        <Text style={styles.stateTitle}>Repository link is incomplete</Text>
        <Pressable accessibilityRole="button" onPress={goBack} style={styles.retryButton}>
          <Text style={styles.retryLabel}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  if (isAuthLoading || (repositoryQuery.isLoading && !repository)) {
    return (
      <View style={[styles.stateScreen, { paddingTop: insets.top }]}>
        <ActivityIndicator color={REFERENCE_THEME.accent} size="large" />
        <Text accessibilityLiveRegion="polite" style={styles.stateBody}>Loading repository…</Text>
      </View>
    );
  }

  if (!repository) {
    return (
      <View style={[styles.stateScreen, { paddingTop: insets.top }]}>
        <Text style={styles.stateTitle}>Couldn&apos;t load this repository</Text>
        <Text style={styles.stateBody}>
          {repositoryQuery.error instanceof Error
            ? repositoryQuery.error.message
            : 'Please try again.'}
        </Text>
        <View style={styles.stateActions}>
          <Pressable accessibilityRole="button" onPress={goBack} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonLabel}>Back</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void repositoryQuery.refetch()}
            style={styles.retryButton}
          >
            <Text style={styles.retryLabel}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 12) }]}>
        <Pressable
          accessibilityLabel="Back"
          accessibilityRole="button"
          hitSlop={10}
          onPress={goBack}
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
        >
          <ArrowLeft color={REFERENCE_THEME.text} size={22} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text numberOfLines={1} style={styles.headerEyebrow}>{repository.owner}</Text>
          <Text numberOfLines={1} style={styles.headerTitle}>{repository.name}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom + 32, 48), width: contentWidth },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <Text selectable style={styles.fullName}>{repository.fullName}</Text>
          <Text selectable style={styles.description}>
            {repository.description || 'No repository description is available.'}
          </Text>
          <View style={styles.stats}>
            <Stat icon={Star} label="stars" value={repository.stats.stars} />
            <Stat icon={GitFork} label="forks" value={repository.stats.forks} />
            <Stat icon={CircleAlert} label="issues" value={repository.stats.openIssues} />
            <Stat icon={Eye} label="views" value={repository.stats.views} />
            <Stat icon={ThumbsUp} label="likes" value={repository.stats.likes} />
          </View>
        </View>

        <View style={styles.actionRow}>
          <DetailAction
            accessibilityLabel={repository.viewerSaved ? 'Manage saved Lists' : 'Save repository to Lists'}
            active={repository.viewerSaved}
            icon={Bookmark}
            label={repository.viewerSaved ? 'Saved' : 'Save'}
            onPress={() => setSaveVisible(true)}
          />
          <DetailAction
            accessibilityLabel="Share repository"
            icon={Share2}
            label="Share"
            onPress={() => setShareVisible(true)}
          />
          <DetailAction
            accessibilityLabel="View full README"
            icon={BookOpen}
            label="README"
            onPress={() => setReadmeVisible(true)}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>README summary</Text>
          <Text selectable style={styles.summary}>{summary}</Text>
          {preparedSummary.source==='summary' ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`Read more about ${repository.name}`}
              accessibilityHint="Opens the complete structured README summary"
              onPress={() => setSummaryVisible(true)} style={styles.readmeButton}>
              <Text style={styles.readmeButtonLabel}>Read more</Text>
            </Pressable>
          ) : summaryQuery.isError || summaryQuery.data?.status==='failed' ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Check README summary again"
              accessibilityHint="Checks whether a summary is available" onPress={() => void summaryQuery.refetch()} style={styles.readmeButton}>
              <Text style={styles.readmeButtonLabel}>Check again</Text>
            </Pressable>
          ) : null}
        </View>

        {languages.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Languages</Text>
            <ScrollView
              contentContainerStyle={styles.chipRow}
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              {languages.map((language) => (
                <View key={language} style={styles.chip}>
                  <Text style={styles.chipLabel}>{language}</Text>
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {repository.topics.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Topics</Text>
            <View style={styles.topicRow}>
              {repository.topics.map((topic) => (
                <View key={topic} style={styles.topicChip}>
                  <Text style={styles.topicLabel}>{topic}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.section}>
          <View style={styles.readmeHeading}>
            <View style={styles.readmeTitleRow}>
              <BookOpen color={REFERENCE_THEME.accentLight} size={18} />
              <Text style={styles.sectionTitle}>README</Text>
            </View>
            <Text style={styles.membershipText}>
              {repository.selectedListIds.length > 0
                ? `In ${repository.selectedListIds.length} ${repository.selectedListIds.length === 1 ? 'List' : 'Lists'}`
                : repository.viewerSaved
                  ? 'Saved in Weave'
                  : 'Not saved to a List'}
            </Text>
          </View>
          <Text style={styles.sectionBody}>
            {partialDetail
              ? repositoryQuery.isError ? 'The complete README could not be loaded.' : 'Loading the complete README…'
              : repository.readmeFull
              ? 'Open the complete repository document without leaving Weave.'
              : 'No README is available for this repository.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={!repository.readmeFull && !partialDetail}
            onPress={() => setReadmeVisible(true)}
            style={({ pressed }) => [
              styles.readmeButton,
              !repository.readmeFull && !partialDetail && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.readmeButtonLabel}>View README</Text>
          </Pressable>
        </View>

        <Pressable
          accessibilityHint="Leaves Weave and opens GitHub"
          accessibilityLabel={`Open ${repository.fullName} on GitHub`}
          accessibilityRole="link"
          onPress={() => void openGithub()}
          style={({ pressed }) => [styles.githubButton, pressed && styles.pressed]}
        >
          <ExternalLink color={REFERENCE_THEME.text} size={18} />
          <Text style={styles.githubButtonLabel}>Open on GitHub</Text>
        </Pressable>
      </ScrollView>

      <SavePopup
        serveId={attribution?.serveId}
        position={attribution?.position}
        sessionId={attribution?.sessionId}
        impressionEventId={attribution?.original?.eventId}
        isVisible={saveVisible}
        onClose={() => setSaveVisible(false)}
        onListMembershipsChanged={handleListMembershipsChanged}
        repoId={repository.id}
        repoName={repository.name}
      />
      <ShareRepositorySheet
        isVisible={shareVisible}
        onClose={() => setShareVisible(false)}
        onShared={() => void queueActivity('share').catch(() => undefined)}
        onGithubOpened={() => void queueActivity('github_open').catch(() => undefined)}
        repositoryDetails={repository}
        repositoryId={repository.id}
      />
      {summaryVisible ? <ReadmePopup
        isVisible contentKind="summary" onClose={() => setSummaryVisible(false)}
        readmeText={prepareReadmeSummaryDocument({ ...repository, readmeDigest: summaryQuery.digest })}
        readmeSource={readmeSource} mediaMarkdown={repository.readmeFull}
        title={repository.name}
      /> : null}
      {readmeVisible ? <ReadmePopup
        isVisible onClose={() => setReadmeVisible(false)}
        readmeText={repository.readmeFull} readmeSource={readmeSource} title={repository.name}
        loading={partialDetail && repositoryQuery.isFetching}
        errorMessage={partialDetail && repositoryQuery.isError ? 'Could not load the complete README.' : undefined}
        onRetry={() => void repositoryQuery.refetch()}
      /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: REFERENCE_THEME.canvas },
  header: {
    alignItems: 'center',
    backgroundColor: REFERENCE_THEME.background,
    borderBottomColor: REFERENCE_THEME.separator,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 74,
    paddingBottom: 12,
    paddingHorizontal: 16,
  },
  headerButton: {
    alignItems: 'center',
    backgroundColor: REFERENCE_THEME.controlStrong,
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  headerCopy: { flex: 1, marginHorizontal: 12 },
  headerEyebrow: { color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 12 },
  headerTitle: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-SemiBold', fontSize: 18 },
  content: { alignSelf: 'center', gap: 16, paddingHorizontal: 0, paddingTop: 18 },
  hero: {
    backgroundColor: REFERENCE_THEME.surface,
    borderColor: REFERENCE_THEME.border,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 14,
    padding: 20,
  },
  fullName: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-Bold', fontSize: 25, lineHeight: 32 },
  description: { color: REFERENCE_THEME.textPrimary, fontFamily: 'NataSans-Regular', fontSize: 15, lineHeight: 23 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  stat: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  statValue: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-SemiBold', fontSize: 13 },
  statLabel: { color: REFERENCE_THEME.textTertiary, fontFamily: 'NataSans-Regular', fontSize: 12 },
  actionRow: { flexDirection: 'row', gap: 10 },
  action: {
    alignItems: 'center',
    backgroundColor: REFERENCE_THEME.surfaceElevated,
    borderColor: REFERENCE_THEME.border,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 10,
  },
  actionActive: { backgroundColor: REFERENCE_THEME.accent, borderColor: REFERENCE_THEME.accent },
  actionLabel: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-SemiBold', fontSize: 13 },
  actionLabelActive: { color: '#07130A' },
  section: {
    backgroundColor: REFERENCE_THEME.surface,
    borderColor: REFERENCE_THEME.border,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
    overflow: 'hidden',
    padding: 18,
  },
  sectionTitle: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-SemiBold', fontSize: 16 },
  summary: { color: REFERENCE_THEME.textPrimary, fontFamily: 'NataSans-Regular', fontSize: 16, lineHeight: 25 },
  sectionBody: { color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 14, lineHeight: 21 },
  chipRow: { gap: 9, paddingRight: 18 },
  chip: { backgroundColor: 'rgba(48,209,88,0.12)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  chipLabel: { color: REFERENCE_THEME.accentLight, fontFamily: 'NataSans-SemiBold', fontSize: 13 },
  topicRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  topicChip: { backgroundColor: REFERENCE_THEME.control, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  topicLabel: { color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 12 },
  readmeHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  readmeTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  membershipText: { color: REFERENCE_THEME.textTertiary, fontFamily: 'NataSans-Regular', fontSize: 12 },
  readmeButton: { minHeight: 44, justifyContent: 'center', alignItems: 'center', alignSelf: 'flex-start', backgroundColor: 'rgba(48,209,88,0.14)', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 11 },
  readmeButtonLabel: { color: REFERENCE_THEME.accentLight, fontFamily: 'NataSans-SemiBold', fontSize: 14 },
  githubButton: { alignItems: 'center', alignSelf: 'center', borderColor: REFERENCE_THEME.border, borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 8, minHeight: 50, paddingHorizontal: 20 },
  githubButtonLabel: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-SemiBold', fontSize: 14 },
  stateScreen: { alignItems: 'center', backgroundColor: REFERENCE_THEME.canvas, flex: 1, gap: 14, justifyContent: 'center', paddingHorizontal: 30 },
  stateTitle: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-SemiBold', fontSize: 20, textAlign: 'center' },
  stateBody: { color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  stateActions: { flexDirection: 'row', gap: 10 },
  retryButton: { backgroundColor: REFERENCE_THEME.accent, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 11 },
  retryLabel: { color: '#07130A', fontFamily: 'NataSans-SemiBold', fontSize: 14 },
  secondaryButton: { borderColor: REFERENCE_THEME.border, borderRadius: 12, borderWidth: 1, paddingHorizontal: 18, paddingVertical: 11 },
  secondaryButtonLabel: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-SemiBold', fontSize: 14 },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.72 },
});
