import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StatusBar, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchExploreRepos, mergeExplorePages } from '../../api/explore';
import RepoCard from '../../components/explore/RepoCard';
import SearchBar from '../../components/explore/SearchBar';
import TabBar from '../../components/explore/TabBar';
import TrendingRepoCard from '../../components/explore/TrendingRepoCard';
import type { RepositoryDetail } from '@/models/repository';
import { repositoryHref } from '@/utils/repository-links';
import { TabName } from '../../types';

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<TabName>('Latest');
  const [searchQuery, setSearchQuery] = useState('');
  const trimmedSearchQuery = searchQuery.trim();

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isFetchNextPageError,
    isLoading,
  } = useInfiniteQuery({
    queryKey: ['exploreRepos', activeTab, trimmedSearchQuery],
    queryFn: ({ pageParam, signal }) => fetchExploreRepos(activeTab, trimmedSearchQuery, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset,
    staleTime: 1000 * 60 * 5,
  });

  const repos = useMemo(() => mergeExplorePages(data?.pages ?? []), [data?.pages]);

  const filteredRepos = useMemo(() => {
    const q = trimmedSearchQuery.toLowerCase();

    if (!q) return repos;

    return repos.filter((repo) => {
      return (
        repo.name.toLowerCase().includes(q) ||
        repo.owner.toLowerCase().includes(q) ||
        repo.description?.toLowerCase().includes(q)
      );
    });
  }, [repos, trimmedSearchQuery]);

  const leftColumn = filteredRepos.filter((_, index) => index % 2 === 0);
  const rightColumn = filteredRepos.filter((_, index) => index % 2 !== 0);

  const handleTabChange = (tab: TabName) => {
    setActiveTab(tab);
    setSearchQuery('');
  };

  const handleRepoPress = (repo: RepositoryDetail) => {
    router.push(repositoryHref(repo.id));
  };

  const feedbackMessage = isError && repos.length === 0
    ? 'Unable to load repositories right now.'
    : filteredRepos.length === 0
      ? 'No repositories found.'
      : null;

  return (
    <View style={{ flex: 1, backgroundColor: 'rgb(0, 0, 0)' }}>
      <StatusBar barStyle="light-content" backgroundColor="rgb(0, 0, 0)" />
      <View
        style={{
          zIndex: 10,
          elevation: 10,
          backgroundColor: 'rgb(0, 0, 0)',
          paddingTop: Math.max(28, insets.top + 16),
          paddingBottom: 10,
        }}
      >
        <Text
          style={{
            color: '#FFFFFF',
            paddingHorizontal: 20,
            fontSize: 30,
            fontWeight: '700',
            letterSpacing: 0,
          }}
        >
          Explore
        </Text>
        <SearchBar value={searchQuery} onChangeText={setSearchQuery} />
        <TabBar activeTab={activeTab} onTabChange={handleTabChange} />
      </View>
      <ScrollView
        style={{ flex: 1, backgroundColor: 'rgb(0, 0, 0)' }}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: Math.max(120, insets.bottom + 96),
        }}
      >
        {isLoading ? (
          <View style={{ minHeight: 260, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color="#63E6A9" />
          </View>
        ) : feedbackMessage ? (
          <View style={{ minHeight: 260, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
            <Text style={{ color: 'rgba(235, 235, 245, 0.65)', fontSize: 14, textAlign: 'center' }}>
              {feedbackMessage}
            </Text>
          </View>
        ) : activeTab === 'Latest' ? (
          <View>
            <View style={{ flexDirection: 'row', gap: 10, paddingTop: 8, paddingHorizontal: 20 }}>
              <View style={{ flex: 1, gap: 10 }}>
                {leftColumn.map((repo) => (
                  <RepoCard key={repo.id} repo={repo} onPress={() => handleRepoPress(repo)} />
                ))}
              </View>
              <View style={{ flex: 1, gap: 10, paddingTop: 30 }}>
                {rightColumn.map((repo) => (
                  <RepoCard key={repo.id} repo={repo} onPress={() => handleRepoPress(repo)} />
                ))}
              </View>
            </View>
            {hasNextPage || isFetchingNextPage || isFetchNextPageError ? (
              <View style={{ alignItems: 'center', paddingHorizontal: 20, paddingTop: 24 }}>
                {isFetchNextPageError ? (
                  <Text style={{ color: '#FF6878', fontSize: 13, marginBottom: 10 }}>
                    Unable to load more repositories.
                  </Text>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  disabled={isFetchingNextPage}
                  onPress={() => void fetchNextPage()}
                  style={{
                    minWidth: 150,
                    minHeight: 46,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 14,
                    backgroundColor: '#1D1D1F',
                    opacity: isFetchingNextPage ? 0.7 : 1,
                  }}
                >
                  {isFetchingNextPage ? (
                    <ActivityIndicator color="#63E6A9" />
                  ) : (
                    <Text style={{ color: '#63E6A9', fontSize: 14, fontWeight: '600' }}>
                      {isFetchNextPageError ? 'Try again' : 'Load more'}
                    </Text>
                  )}
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : (
          <View style={{ paddingTop: 12, paddingHorizontal: 9, gap: 10 }}>
            {filteredRepos.map((repo, index) => (
              <TrendingRepoCard
                key={repo.id}
                repo={repo}
                rank={searchQuery.trim() ? undefined : index + 1}
                onPress={() => handleRepoPress(repo)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
