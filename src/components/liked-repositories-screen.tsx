import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { ArrowLeft, FolderGit2, GitFork, Heart, Star } from 'lucide-react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { apiV2 } from '@/api/client';
import type { RepositoryApiPayload } from '@/api/repositories';
import type { RepositoryDetail } from '@/models/repository';
import { formatCompactCount } from '@/utils/format-count';
import { repositoryHref } from '@/utils/repository-links';
import { mapRepositoryList } from '@/utils/repository-mapper';
import { getStorageItem } from '@/utils/storage';

export default function LikedRepositoriesScreen() {
  const { width } = useWindowDimensions();
  const { username, userId } = useLocalSearchParams<{ username?: string; userId?: string }>();
  const [repositories, setRepositories] = useState<RepositoryDetail[]>([]);
  const [loading, setLoading] = useState(Boolean(userId));
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    if (!userId) {
      return () => controller.abort();
    }

    getStorageItem('access_token')
      .then((token) => {
        if (!token) throw new Error('Your session has expired.');
        return apiV2<{ items: RepositoryApiPayload[] }>(
          `/users/${encodeURIComponent(userId)}/likes-given?limit=100&offset=0`,
          { signal: controller.signal },
          token,
        );
      })
      .then((data) => {
        if (active) setRepositories(mapRepositoryList(Array.isArray(data.items) ? data.items : []));
      })
      .catch((caught) => {
        if (active && caught.name !== 'AbortError') {
          setError(caught instanceof Error ? caught.message : 'Unable to load liked repositories.');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [userId]);

  const openRepository = (repository: RepositoryDetail) => {
    router.push(repositoryHref(repository.id));
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000000', alignItems: 'center' }}>
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        style={{ width: width >= 768 ? '68%' : '100%', maxWidth: 650 }}
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: '7%', paddingBottom: '10%' }}
        data={repositories}
        keyExtractor={(item) => item.id}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        ListHeaderComponent={<View style={{ paddingTop: '8%', paddingBottom: '7%', gap: 18 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable accessibilityLabel="Go back" onPress={() => router.back()} hitSlop={12} style={{ width: '15%' }}>
              <ArrowLeft color="#F7F7F8" size={27} />
            </Pressable>
            <Text selectable style={{ flex: 1, color: '#F7F7F8', textAlign: 'center', fontFamily: 'NataSans-Bold', fontSize: width < 360 ? 22 : 26 }}>Likes Given</Text>
            <View style={{ width: '15%' }} />
          </View>
          <Text selectable style={{ color: '#6F6E74', textAlign: 'center', fontFamily: 'NataSans-Regular' }}>@{username}</Text>
        </View>}
        ListEmptyComponent={<View style={{ minHeight: 320, flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }}>
          {loading ? <ActivityIndicator color="#63E08A" /> : <>
            <View style={{ width: '18%', maxWidth: 74, aspectRatio: 1, borderRadius: 999, backgroundColor: '#151515', alignItems: 'center', justifyContent: 'center' }}>
              <FolderGit2 size={31} color="#63E08A" />
            </View>
            <Text selectable style={{ color: '#F7F7F8', fontFamily: 'NataSans-SemiBold', fontSize: 17, textAlign: 'center' }}>
              {!username ? 'Username is unavailable.' : error || 'No liked repositories yet'}
            </Text>
          </>}
        </View>}
        renderItem={({ item }) => <Pressable cssInterop={false}
          accessibilityRole="link"
          accessibilityLabel={`Open ${item.fullName}`}
          onPress={() => openRepository(item)}
          style={({ pressed }) => ({
            minHeight: width < 360 ? 92 : 104,
            borderRadius: 20,
            borderCurve: 'continuous',
            backgroundColor: '#151515',
            paddingHorizontal: '4%',
            paddingVertical: 14,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <View style={{ width: '14%', maxWidth: 52, aspectRatio: 1, borderRadius: 14, borderCurve: 'continuous', backgroundColor: '#242424', alignItems: 'center', justifyContent: 'center' }}>
            <FolderGit2 size={width < 360 ? 20 : 24} color="#63E08A" />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text selectable numberOfLines={1} style={{ color: '#F7F7F8', fontFamily: 'NataSans-SemiBold', fontSize: width < 360 ? 14 : 16 }}>{item.name}</Text>
            <Text selectable numberOfLines={1} style={{ color: '#77767C', fontFamily: 'NataSans-Regular', fontSize: width < 360 ? 11 : 13 }}>{item.owner}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Star size={12} color="#F5C54D" fill="#F5C54D" /><Text selectable style={{ color: '#8A898F', fontFamily: 'NataSans-Regular', fontSize: 11, fontVariant: ['tabular-nums'] }}>{formatCompactCount(item.stats.stars)}</Text></View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><GitFork size={12} color="#8A898F" /><Text selectable style={{ color: '#8A898F', fontFamily: 'NataSans-Regular', fontSize: 11, fontVariant: ['tabular-nums'] }}>{formatCompactCount(item.stats.forks)}</Text></View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Heart size={12} color="#63E08A" /><Text selectable style={{ color: '#8A898F', fontFamily: 'NataSans-Regular', fontSize: 11, fontVariant: ['tabular-nums'] }}>{formatCompactCount(item.stats.likes)}</Text></View>
            </View>
          </View>
        </Pressable>}
      />
    </View>
  );
}
