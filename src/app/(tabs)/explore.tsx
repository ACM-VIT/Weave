import { rememberRepositoryPreview } from '@/services/repositoryPreview';
import { KeyboardSurface } from '@/components/keyboard/keyboard-layout';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StatusBar, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { useNetInfo } from '@react-native-community/netinfo';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchExploreRepos, mergeExplorePages } from '@/api/explore';
import { fetchSearch } from '@/api/search';
import { MIN_SEARCH_LENGTH, searchQueryOptions, isSearchExpired, SearchSessions, SearchRequestTiming } from '@/api/search-query';
import SearchBar from '@/components/explore/SearchBar';
import RepoCard from '@/components/explore/RepoCard';
import TabBar from '@/components/explore/TabBar';
import TrendingRepoCard from '@/components/explore/TrendingRepoCard';
import SearchFilterTabs from '@/components/explore/search-filter-tabs';
import { searchResultHref, type SearchGroup, type SearchItem } from '@/models/search';
import { useAuth } from '@/store/AuthContext';
import type { TabName } from '@/types';

function SearchRow({ item }: { item: SearchItem }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const open = () => {
    if (item.type === 'repository') rememberRepositoryPreview(queryClient, user?.user_id, item.data);
    router.push(searchResultHref(item));
  };
  if (item.type === 'repository') return <TrendingRepoCard repo={item.data} onPress={open} />;
  const title = item.type === 'person' ? item.data.display_name || item.data.username : item.data.name;
  const subtitle = item.type === 'person' ? `@${item.data.username}${item.data.bio ? ` · ${item.data.bio}` : ''}` : `${item.data.repositoryCount} repositories${item.data.description ? ` · ${item.data.description}` : ''}`;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.type === 'person' ? 'profile' : 'List'} ${title}`} onPress={open}
    style={({ pressed }) => ({ padding: 16, gap: 5, borderRadius: 16, backgroundColor: '#1C1C1E', opacity: pressed ? 0.7 : 1 })}>
    <Text style={{ color: '#63E6A9', fontSize: 11, fontWeight: '700' }}>{item.type === 'person' ? 'PERSON' : 'LIST'}</Text>
    <Text numberOfLines={1} style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>{title}</Text>
    <Text numberOfLines={2} style={{ color: '#B8B8C0', fontSize: 13, lineHeight: 19 }}>{subtitle}</Text>
  </Pressable>;
}

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const network = useNetInfo();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabName>('Latest');
  const [sessions] = useState(() => new SearchSessions(randomUUID));
  const [searchTiming] = useState(() => new SearchRequestTiming());
  const [searchInput, setSearchInput] = useState({ value: '', group: 'all' as SearchGroup });
  const { value: searchQuery, group } = searchInput;
  const searchId = sessions.get(user?.user_id, searchQuery, group);
  const setSearchQuery = (value: string) => {
    searchTiming.typed();
    setSearchInput(previous => ({ ...previous, value }));
  };
  const setGroup = (nextGroup: SearchGroup) => {
    searchTiming.explicit();
    setSearchInput(previous => previous.group === nextGroup ? previous : { ...previous, group: nextGroup });
  };
  const restartSearch = () => {
    searchTiming.explicit();
    sessions.get(user?.user_id, searchQuery, group, true);
    setSearchInput(previous => ({ ...previous }));
  };
  const [period, setPeriod] = useState<string>();
  const [composing, setComposing] = useState(false);
  const query = searchQuery.trim();
  const searching = query.length > 0;
  const search = useInfiniteQuery(searchQueryOptions({
    viewer: user?.user_id, query, group, searchId, composing, offline, timing: searchTiming,
    send: (cursor, signal) => fetchSearch(query, group, searchId, cursor, signal),
  }));
  const browse = useInfiniteQuery({
    queryKey: ['exploreRepos', user?.user_id, activeTab, period],
    enabled: !searching && !offline && Boolean(user?.user_id),
    queryFn: ({ pageParam, signal }) => fetchExploreRepos(activeTab,'',pageParam,signal,period),
    initialPageParam: 0,
    getNextPageParam: page => page.nextOffset,
    staleTime: 60_000,
  });
  const items = useMemo<SearchItem[]>(() => searching
    ? [...new Map((search.data?.pages ?? []).flatMap(page => page.items).map(item => [`${item.type}:${item.id}`,item])).values()]
    : mergeExplorePages(browse.data?.pages ?? []).map(repo => ({ type: 'repository', id: repo.id, data: repo })),
  [searching,search.data?.pages,browse.data?.pages]);
  const current = searching ? search : browse;
  const twoColumns = searching || activeTab === 'Latest';
  const periods = browse.data?.pages[0]?.availablePeriods ?? [];
  const selectedPeriod = browse.data?.pages[0]?.period ?? period;
  const fallback = searching && search.data?.pages.some(page => page.mode === 'lexical');
  const status = searching && query.length < MIN_SEARCH_LENGTH ? 'Type at least 2 characters to search.'
    : composing ? 'Finish typing to search.'
    : offline || current.fetchStatus === 'paused' ? 'You’re offline. Reconnect to search again.'
    : current.isError ? 'Could not load results. Check your connection and try again.'
    : 'No results found. Try another search or filter.';
  return <KeyboardSurface style={{ flex: 1, backgroundColor: '#000000' }}>
    <StatusBar barStyle="light-content" />
    <View style={{ paddingTop: Math.max(28,insets.top+16), paddingBottom: 8 }}>
      <Text accessibilityRole="header" style={{ color: '#FFFFFF', paddingHorizontal: 20, fontSize: 30, fontWeight: '700' }}>Explore</Text>
      <SearchBar value={searchQuery} onChangeText={setSearchQuery} onCompositionChange={setComposing} />
      {searching ? <SearchFilterTabs value={group} onChange={setGroup} /> : null}
      {!searching ? <TabBar activeTab={activeTab} onTabChange={setActiveTab} /> : null}
      {!searching && activeTab === 'Trending' && periods.length > 1 ? <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: 20, gap: 8, paddingTop: 12 }}>
        {periods.map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: value === selectedPeriod }} onPress={() => setPeriod(value)}
          style={{ minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 22, backgroundColor: value === selectedPeriod ? '#FFFFFF' : '#272729' }}>
          <Text style={{ color: value === selectedPeriod ? '#000000' : '#FFFFFF', textTransform: 'capitalize' }}>{value}</Text>
        </Pressable>)}
      </ScrollView> : null}
    </View>
    <FlashList<SearchItem>
      key={`${searching ? group : activeTab}:${query}:${selectedPeriod ?? ''}`}
      data={items}
      keyExtractor={item => `${item.type}:${item.id}`}
      numColumns={twoColumns ? 2 : 1}
      masonry={twoColumns}
      optimizeItemArrangement={false}
      getItemType={item => item.type}
      renderItem={({ item }) => (
        <View style={{ minWidth: 0, paddingHorizontal: 5, paddingBottom: 10 }}>
          {twoColumns && item.type === 'repository'
            ? <RepoCard repo={item.data} onPress={() => {
              rememberRepositoryPreview(queryClient, user?.user_id, item.data);
              router.push(searchResultHref(item));
            }} />
            : <SearchRow item={item} />}
        </View>
      )}
      showsVerticalScrollIndicator={false}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 15, paddingTop: 8, paddingBottom: Math.max(120,insets.bottom+96) }}
      ListHeaderComponent={<>
        {offline && items.length > 0 ? <Text accessibilityLiveRegion="polite" style={{ color: '#FFD60A', paddingBottom: 10 }}>You’re offline. Showing previous results.</Text> : null}
        {fallback ? <Text accessibilityLiveRegion="polite" style={{ color: '#FFD60A', paddingBottom: 10 }}>Showing keyword matches. Some related results may be unavailable.</Text> : null}
        {current.isError && items.length > 0 ? <Text style={{ color: '#FF6878', paddingBottom: 10 }}>Could not refresh. Showing previous results.</Text> : null}
        {!searching && activeTab === 'Trending' && selectedPeriod ? <Text style={{ color: '#B8B8C0', paddingBottom: 10 }}>Trending · {selectedPeriod}</Text> : null}
      </>}
      ListEmptyComponent={<View style={{ minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        {current.isLoading ? <ActivityIndicator color="#63E6A9" accessibilityLabel="Loading results" /> : <Text selectable accessibilityLiveRegion="polite" style={{ color: '#B8B8C0', textAlign: 'center' }}>{status}</Text>}
        {current.isError ? <Pressable accessibilityRole="button" disabled={offline} onPress={() => {
          searchTiming.explicit();
          if (searching && isSearchExpired(search.error)) restartSearch();
          else void current.refetch();
        }} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: '#63E6A9' }}>{searching && isSearchExpired(search.error) ? 'Restart search' : 'Try again'}</Text></Pressable> : null}
      </View>}
      ListFooterComponent={current.hasNextPage || current.isFetchNextPageError ? <View style={{ minHeight: 64, alignItems: 'center', justifyContent: 'center' }}>
        {current.isFetchNextPageError ? <Text style={{ color: '#FF6878' }}>Could not load more results.</Text> : null}
        <Pressable accessibilityRole="button" disabled={offline || current.isFetchingNextPage} onPress={() => {
          searchTiming.explicit();
          if (searching && isSearchExpired(search.error)) restartSearch();
          else void current.fetchNextPage();
        }} style={{ minHeight: 48, minWidth: 160, alignItems: 'center', justifyContent: 'center' }}>
          {current.isFetchingNextPage ? <ActivityIndicator color="#63E6A9" /> : <Text style={{ color: '#63E6A9' }}>{searching && isSearchExpired(search.error) ? 'Restart search' : current.isFetchNextPageError ? 'Try again' : 'Load more'}</Text>}
        </Pressable>
      </View> : null}
    />
  </KeyboardSurface>;
}
