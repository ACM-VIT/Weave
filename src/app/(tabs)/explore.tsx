import { useMemo, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StatusBar, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchExploreRepos } from '../../api/explore';
import RepoCard from '../../components/explore/RepoCard';
import SearchBar from '../../components/explore/SearchBar';
import TabBar from '../../components/explore/TabBar';
import TrendingRepoCard from '../../components/explore/TrendingRepoCard';
import { Repo, TabName } from '../../types';
import { useAuth } from '../../store/AuthContext';
import { getStorageItem } from '../../utils/storage';
import { getActivityOutbox } from '../../services/activityOutboxClient';

export default function ExploreScreen() {
  const { user } = useAuth();
  const activityOutbox = user?.user_id && !(__DEV__ && user.isPreview)
    ? getActivityOutbox(user.user_id)
    : null;
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<TabName>('Latest');
  const [searchQuery, setSearchQuery] = useState('');
  const trimmedSearchQuery = searchQuery.trim();

  const {
    data: repos = [],
    isError,
    isLoading,
  } = useQuery({
    queryKey: ['exploreRepos', activeTab, trimmedSearchQuery],
    queryFn: ({ signal }) => fetchExploreRepos(activeTab, trimmedSearchQuery, signal),
    staleTime: 1000 * 60 * 5,
  });

  const filteredRepos = useMemo(() => {
    const q = trimmedSearchQuery.toLowerCase();

    if (!q) return repos;

    return repos.filter((repo) => {
      return (
        repo.name.toLowerCase().includes(q) ||
        repo.author.toLowerCase().includes(q) ||
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

  const handleRepoPress = async (repo: Repo) => {
    const fallbackUrl = `https://github.com/${repo.author}/${repo.name}`;
    const url = repo.url?.startsWith('https://github.com/') ? repo.url : fallbackUrl;
    try {
      await Linking.openURL(url);
      if (!activityOutbox) return;
      await activityOutbox.enqueue({ repo_id: repo.id, action: 'github_open' });
      const token = await getStorageItem('access_token');
      if (!token) return;
      await activityOutbox.flush(token);
    } catch {
      // The durable event remains queued when delivery is offline or interrupted.
    }
  };

  const feedbackMessage = isError
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
