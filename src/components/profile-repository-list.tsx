import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { FolderGit2, GitFork, Heart, RotateCcw, Search, Star, X } from 'lucide-react-native';

import { apiV2 } from '@/api/client';
import type { RepositoryApiPayload } from '@/api/repositories';
import { REFERENCE_THEME } from '@/constants/theme';
import type { RepositoryDetail } from '@/models/repository';
import { formatCompactCount } from '@/utils/format-count';
import { README_SUMMARY_PENDING } from '@/utils/readme';
import { repositoryHref } from '@/utils/repository-links';
import { mapRepositoryList } from '@/utils/repository-mapper';
import { getStorageItem } from '@/utils/storage';

export type ProfileRepositoryType = 'likes' | 'saved';

async function loadRepositories(
  type: ProfileRepositoryType,
  userId: string,
  signal?: AbortSignal,
): Promise<RepositoryDetail[]> {
  const token = await getStorageItem('access_token');
  if (!token) throw new Error('Your session has expired. Please sign in again.');
  const path = type === 'likes'
    ? `/users/${encodeURIComponent(userId)}/likes-given?limit=100&offset=0`
    : '/repositories/saved?limit=100&offset=0';
  const data = await apiV2<{ items: RepositoryApiPayload[] }>(path, { signal }, token);
  return mapRepositoryList(Array.isArray(data.items) ? data.items : []);
}

export function ProfileRepositoryList({
  active,
  contentPaddingBottom = 24,
  type,
  userId,
}: {
  active?: boolean;
  contentPaddingBottom?: number;
  type: ProfileRepositoryType;
  userId?: string;
}) {
  const { width } = useWindowDimensions();
  const searchInputRef = useRef<TextInput>(null);
  const compact = width < 360;
  const searchKey = `${type}:${userId ?? 'missing'}`;
  const [searchState, setSearchState] = useState({ key: searchKey, value: '' });
  const search = searchState.key === searchKey ? searchState.value : '';
  const setSearch = (value: string) => setSearchState({ key: searchKey, value });
  const repositoriesQuery = useQuery({
    queryKey: ['profile-stat-repositories', type, userId],
    enabled: active && Boolean(userId),
    queryFn: ({ signal }) => loadRepositories(type, userId!, signal),
    staleTime: 30_000,
  });
  const filteredRepositories = useMemo(() => {
    const repositories = repositoriesQuery.data ?? [];
    const query = search.trim().toLocaleLowerCase();
    if (!query) return repositories;
    return repositories.filter((repository) =>
      repository.name.toLocaleLowerCase().includes(query)
      || repository.owner.toLocaleLowerCase().includes(query)
      || repository.description.toLocaleLowerCase().includes(query)
      || repository.readmeSummary?.toLocaleLowerCase().includes(query)
    );
  }, [repositoriesQuery.data, search]);

  const emptyState = (() => {
    if (!userId) return <StateView message="This profile could not be identified." title="Profile unavailable" />;
    if (repositoriesQuery.isLoading) return <StateView loading title={`Loading ${type === 'likes' ? 'liked' : 'saved'} repositories...`} />;
    if (repositoriesQuery.isError) {
      return (
        <StateView
          message={repositoriesQuery.error instanceof Error ? repositoriesQuery.error.message : 'Check your connection and try again.'}
          onRetry={() => void repositoriesQuery.refetch()}
          title={`${type === 'likes' ? 'Liked' : 'Saved'} repositories could not load`}
        />
      );
    }
    if (search.trim()) return <StateView message="Try another repository or owner name." title="No matching repositories" />;
    return (
      <StateView
        message={type === 'likes'
          ? 'Repositories you like from Home will appear here.'
          : 'Repositories you save from Home will appear here.'}
        title={type === 'likes' ? 'No liked repositories yet' : 'No saved repositories yet'}
      />
    );
  })();

  return (
    <View style={styles.root}>
      <View style={[styles.searchBox, compact && styles.searchBoxCompact]}>
        <Search color={REFERENCE_THEME.textTertiary} size={18} strokeWidth={1.8} />
        <TextInput
          ref={searchInputRef}
          accessibilityLabel={`Search ${type === 'likes' ? 'liked' : 'saved'} repositories`}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setSearch}
          placeholder="Search repositories"
          placeholderTextColor={REFERENCE_THEME.textSecondary}
          returnKeyType="search"
          style={styles.searchInput}
          value={search}
        />
        {search ? (
          <Pressable accessibilityLabel="Clear search" hitSlop={14} accessibilityRole="button" onPress={() => { setSearch(''); searchInputRef.current?.focus(); }} style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}>
            <X color={REFERENCE_THEME.textSecondary} size={13} strokeWidth={2.4} />
          </Pressable>
        ) : null}
      </View>

      <FlatList
        columnWrapperStyle={styles.rowColumns}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: contentPaddingBottom },
          filteredRepositories.length === 0 && styles.emptyListContent,
        ]}
        contentInsetAdjustmentBehavior="automatic"
        data={filteredRepositories}
        initialNumToRender={10}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(repository) => repository.id}
        ListEmptyComponent={emptyState}
        numColumns={2}
        onRefresh={userId ? () => void repositoriesQuery.refetch() : undefined}
        refreshing={repositoriesQuery.isRefetching}
        renderItem={({ item }) => (
          <View style={[styles.row, compact && styles.rowCompact]}>
            <View pointerEvents="none" style={styles.cardContent}>
              <View style={[styles.repoIcon, compact && styles.repoIconCompact]}>
                <FolderGit2 color={REFERENCE_THEME.accentLight} size={compact ? 20 : 23} strokeWidth={1.8} />
              </View>
              <View style={styles.copy}>
                <Text numberOfLines={1} style={[styles.name, compact && styles.nameCompact]}>{item.name}</Text>
                <Text numberOfLines={1} style={styles.owner}>{item.owner}</Text>
                <Text numberOfLines={2} style={styles.summary}>
                  {item.readmeSummary || item.description || README_SUMMARY_PENDING}
                </Text>
                <View style={styles.metrics}>
                  <Metric icon={<Star color="#F5C54D" fill="#F5C54D" size={11} />} value={item.stats.stars} />
                  <Metric icon={<GitFork color={REFERENCE_THEME.textTertiary} size={11} />} value={item.stats.forks} />
                  {type === 'likes' ? <Metric icon={<Heart color={REFERENCE_THEME.accentLight} size={11} />} value={item.stats.likes} /> : null}
                </View>
              </View>
            </View>
            <Pressable
              accessibilityHint="Opens this repository in Weave"
              accessibilityLabel={`Open ${item.fullName}`}
              accessibilityRole="link"
              onPress={() => router.push(repositoryHref(item.id))}
              style={({ pressed }) => [StyleSheet.absoluteFill, pressed && styles.cardPressedOverlay]}
            />
          </View>
        )}
        showsVerticalScrollIndicator={false}
        style={styles.list}
      />
    </View>
  );
}

function Metric({ icon, value }: { icon: React.ReactNode; value: number }) {
  return <View style={styles.metric}>{icon}<Text style={styles.metricText}>{formatCompactCount(value)}</Text></View>;
}

function StateView({ loading, message, onRetry, title }: { loading?: boolean; message?: string; onRetry?: () => void; title: string }) {
  return (
    <View style={styles.state}>
      {loading ? <ActivityIndicator color={REFERENCE_THEME.accent} size="small" /> : <View style={styles.stateIcon}><FolderGit2 color={REFERENCE_THEME.textTertiary} size={29} strokeWidth={1.5} /></View>}
      <Text style={styles.stateTitle}>{title}</Text>
      {message ? <Text style={styles.stateMessage}>{message}</Text> : null}
      {onRetry ? <Pressable onPress={onRetry} style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}><RotateCcw color={REFERENCE_THEME.accent} size={14} /><Text style={styles.retryText}>Try again</Text></Pressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  searchBox: { height: 44, marginHorizontal: 18, marginTop: 14, marginBottom: 12, borderRadius: 14, borderCurve: 'continuous', paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: REFERENCE_THEME.control, borderWidth: StyleSheet.hairlineWidth, borderColor: REFERENCE_THEME.separator },
  searchBoxCompact: { height: 40, marginHorizontal: 14 },
  searchInput: { flex: 1, minWidth: 0, paddingVertical: 0, color: REFERENCE_THEME.text, fontFamily: 'NataSans-Regular', fontSize: 14 },
  clearButton: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: REFERENCE_THEME.controlStrong },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 18 },
  emptyListContent: { flexGrow: 1 },
  rowColumns: { justifyContent: 'space-between' },
  separator: { height: 14 },
  row: { width: '48.3%', minHeight: 168, borderRadius: 18, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: REFERENCE_THEME.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: REFERENCE_THEME.separator, boxShadow: '0 3px 12px rgba(0,0,0,0.18)' },
  rowCompact: { minHeight: 158 },
  cardContent: { flex: 1, paddingHorizontal: 13, paddingVertical: 12, gap: 10 },
  cardPressedOverlay: { backgroundColor: 'rgba(255,255,255,0.06)' },
  repoIcon: { width: 48, height: 48, flexShrink: 0, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: REFERENCE_THEME.control },
  repoIconCompact: { width: 42, height: 42, borderRadius: 12 },
  copy: { minWidth: 0, gap: 2 },
  name: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-SemiBold', fontSize: 15, lineHeight: 19 },
  nameCompact: { fontSize: 13, lineHeight: 17 },
  owner: { color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 12, lineHeight: 16 },
  summary: { minHeight: 30, marginTop: 2, color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 10.5, lineHeight: 15 },
  metrics: { marginTop: 3, flexDirection: 'row', alignItems: 'center', gap: 12 },
  metric: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metricText: { color: REFERENCE_THEME.textTertiary, fontFamily: 'NataSans-Regular', fontSize: 10.5, fontVariant: ['tabular-nums'] },
  state: { flex: 1, minHeight: 250, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center' },
  stateIcon: { width: 64, height: 64, marginBottom: 4, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: REFERENCE_THEME.control, borderWidth: StyleSheet.hairlineWidth, borderColor: REFERENCE_THEME.separator },
  stateTitle: { marginTop: 12, color: REFERENCE_THEME.text, fontFamily: 'NataSans-SemiBold', fontSize: 17, lineHeight: 22, textAlign: 'center' },
  stateMessage: { maxWidth: 320, marginTop: 6, color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  retryButton: { minHeight: 36, marginTop: 16, borderRadius: 999, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: REFERENCE_THEME.controlStrong },
  retryText: { color: REFERENCE_THEME.accent, fontFamily: 'NataSans-SemiBold', fontSize: 13 },
  pressed: { opacity: 0.7, transform: [{ scale: 0.985 }] },
});
