import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiV2 } from '@/api/client';
import { REFERENCE_THEME as theme } from '@/constants/theme';
import { getActivityOutbox } from '@/services/activityOutboxClient';
import { openRepositoryOnGitHub } from '@/services/repositoryGithubOpen';
import { useAuth } from '@/store/AuthContext';
import { formatCompactCount } from '@/utils/format-count';
import { getStorageItem } from '@/utils/storage';

type Repository = {
  url: string;
  full_name: string;
  description: string | null;
  summary: string | null;
  readme: string | null;
  primary_language: string | null;
  star_count: number | null;
  fork_count: number | null;
  topics: string[];
};

export default function RepositoryScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const activityOutbox = user?.user_id ? getActivityOutbox(user.user_id) : null;
  const [openError, setOpenError] = useState(false);
  const repository = useQuery({
    queryKey: ['repository', user?.user_id, repoId],
    enabled: Boolean(repoId && user?.user_id),
    queryFn: async ({ signal }) => {
      const token = await getStorageItem('access_token');
      signal.throwIfAborted();
      if (!token) throw new Error('Sign in to view this repository.');
      return apiV2<Repository>(`/repositories/${encodeURIComponent(repoId)}`, { signal }, token);
    },
    retry: false,
  });
  const repo = repository.data;
  const missing = repository.error && 'status' in repository.error && repository.error.status === 404;
  const openOnGitHub = async () => {
    if (!repo?.url) return;
    setOpenError(false);
    const opened = await openRepositoryOnGitHub(repoId, repo.url, {
      open: url => Linking.openURL(url), outbox: activityOutbox, token: () => getStorageItem('access_token'),
    });
    setOpenError(!opened);
  };

  return <ScrollView
    style={{ flex: 1, backgroundColor: theme.background }}
    contentInsetAdjustmentBehavior="automatic"
    contentContainerStyle={{ padding: 20, paddingTop: Math.max(insets.top, 20), paddingBottom: insets.bottom + 32, gap: 20 }}
  >
    <Stack.Screen options={{ title: repo?.full_name ?? 'Repository' }} />
    <Pressable accessibilityRole="button" accessibilityLabel="Back to Explore"
      onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/explore')}
      style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
      <Text style={{ color: theme.accent, fontSize: 16 }}>Back</Text>
    </Pressable>
    {repository.isLoading ? <ActivityIndicator accessibilityLabel="Loading repository" color={theme.accent} /> : null}
    {repository.isError ? <View style={{ gap: 12 }}>
      <Text selectable accessibilityLiveRegion="polite" style={{ color: theme.textSecondary }}>
        {missing ? 'This repository is no longer available.' : 'Could not load this repository. Check your connection and try again.'}
      </Text>
      {!missing ? <Pressable accessibilityRole="button" onPress={() => void repository.refetch()}
        style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text style={{ color: theme.accent }}>Try again</Text>
      </Pressable> : null}
    </View> : null}
    {repo ? <>
      <Text selectable accessibilityRole="header" style={{ color: theme.text, fontSize: 28, fontWeight: '700' }}>{repo.full_name}</Text>
      <Text selectable style={{ color: theme.textSecondary, fontSize: 15, lineHeight: 23 }}>{repo.description || 'No description provided.'}</Text>
      {repo.url ? <Pressable accessibilityRole="link" accessibilityLabel="Open on GitHub"
        onPress={() => void openOnGitHub()}
        style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
        <Text style={{ color: theme.accent, fontSize: 16 }}>Open on GitHub</Text>
      </Pressable> : null}
      {openError ? <Text accessibilityLiveRegion="polite" style={{ color: theme.textSecondary }}>Could not open GitHub. Try again.</Text> : null}
      <Text selectable style={{ color: theme.textSecondary, fontVariant: ['tabular-nums'] }}>
        {repo.primary_language ? `${repo.primary_language} · ` : ''}{formatCompactCount(repo.star_count)} stars · {formatCompactCount(repo.fork_count)} forks
      </Text>
      {repo.topics?.length ? <Text selectable style={{ color: theme.accent }}>{repo.topics.join(' · ')}</Text> : null}
      {repo.summary ? <View style={{ backgroundColor: theme.surface, borderRadius: 16, padding: 16, gap: 10 }}>
        <Text accessibilityRole="header" style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>Summary</Text>
        <Text selectable style={{ color: theme.textPrimary, fontSize: 15, lineHeight: 23 }}>{repo.summary}</Text>
      </View> : null}
      <Text accessibilityRole="header" style={{ color: theme.text, fontSize: 20, fontWeight: '600' }}>README</Text>
      <Text selectable style={{ color: theme.textPrimary, fontSize: 15, lineHeight: 24 }}>{repo.readme || 'No README available.'}</Text>
    </> : null}
  </ScrollView>;
}
