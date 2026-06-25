import { useState, useEffect } from 'react';
import { ScrollView, FlatList, StatusBar, View, Text, ListRenderItemInfo, useWindowDimensions } from 'react-native';
import Header from '../../components/explore/Header';
import RepoCard from '../../components/explore/RepoCard';
import SearchBar from '../../components/explore/SearchBar';
import TabBar from '../../components/explore/TabBar';
import TrendingRepoCard from '../../components/explore/TrendingRepoCard';
import SkeletonCard from '../../components/explore/SkeletonCard';
import { getResponsiveContainerStyle } from '../../components/responsive-layout';
import { FOR_YOU_REPOS, TRENDING_REPOS } from '../../data/repos';
import { Repo, TabName } from '../../types';
import { APP_THEME } from '../../constants/theme';

const regular = { fontFamily: 'NotoSans_400Regular' };

export default function ExploreScreen() {
  const { width } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<TabName>('For you');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const responsiveContainerStyle = getResponsiveContainerStyle(width);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 1000);
    return () => clearTimeout(timer);
  }, [activeTab]);

  const handleTabChange = (tab: TabName) => {
    setActiveTab(tab);
    setSearchQuery('');
    setIsLoading(true);
  };

  const filteredForYou: Repo[] = FOR_YOU_REPOS.filter((r) =>
    r.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const skeletonDataForYou = Array.from({ length: 6 }, (_, i) => ({ id: `skeleton-${i}` }));
  const dataForYou = isLoading ? skeletonDataForYou : filteredForYou;
  const leftColData = dataForYou.filter((_, idx) => idx % 2 === 0);
  const rightColData = dataForYou.filter((_, idx) => idx % 2 !== 0);

  const filteredTrending = TRENDING_REPOS.filter((r) =>
    r.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const skeletonDataTrending = Array.from({ length: 5 }, (_, i) => ({ id: `skeleton-${i}`, isSkeleton: true }));
  const dataTrending = isLoading
    ? skeletonDataTrending
    : searchQuery
    ? filteredTrending
    : [
        ...(TRENDING_REPOS.length > 0 ? [TRENDING_REPOS[0]] : []),
        { id: 'skeleton-1', isSkeleton: true },
        { id: 'skeleton-2', isSkeleton: true },
        { id: 'skeleton-3', isSkeleton: true },
        { id: 'skeleton-4', isSkeleton: true },
      ];

  const renderTrendingCard = ({ item }: ListRenderItemInfo<any>) => (
    <View className="px-4">
      {item.isSkeleton ? (
        <SkeletonCard height={120} />
      ) : (
        <TrendingRepoCard repo={item} />
      )}
    </View>
  );

  const renderEmptyState = (hasData: boolean) => {
    if (isLoading || hasData) return null;
    return (
      <View className="items-center justify-center py-16">
        <Text className="text-[#6B7280] text-sm" style={regular}>
          No repositories found
        </Text>
      </View>
    );
  };

  return (
    <View className="flex-1" style={{ backgroundColor: APP_THEME.background }}>
      <StatusBar barStyle="light-content" backgroundColor={APP_THEME.background} />
      <View style={[{ flex: 1, width: '100%' }, responsiveContainerStyle]}>
        <Header />

        <View className="pt-3">
          <SearchBar value={searchQuery} onChangeText={setSearchQuery} />
        </View>

        <TabBar activeTab={activeTab} onTabChange={handleTabChange} />

        {activeTab === 'For you' ? (
          <ScrollView
            style={{ flex: 1 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 24, paddingTop: 12 }}
          >
            {renderEmptyState(dataForYou.length > 0)}

            {dataForYou.length > 0 && (
              <View className="flex-row px-4" style={{ gap: 16 }}>
                <View className="flex-1" style={{ gap: 16 }}>
                  {leftColData.map((item) => (
                    <View key={item.id}>
                      {isLoading ? (
                        <SkeletonCard height={95} />
                      ) : (
                        <RepoCard repo={item as Repo} />
                      )}
                    </View>
                  ))}
                </View>

                <View className="flex-1" style={{ gap: 16 }}>
                  {rightColData.map((item) => (
                    <View key={item.id}>
                      {isLoading ? (
                        <SkeletonCard height={95} />
                      ) : (
                        <RepoCard repo={item as Repo} />
                      )}
                    </View>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>
        ) : (
          <FlatList<any>
            style={{ flex: 1 }}
            data={dataTrending}
            keyExtractor={(item) => item.id}
            renderItem={renderTrendingCard}
            contentContainerStyle={{ paddingBottom: 24, paddingTop: 12, gap: 16 }}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={renderEmptyState(dataTrending.length > 0)}
          />
        )}
      </View>
    </View>
  );
}
