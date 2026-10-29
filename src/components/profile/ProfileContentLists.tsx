import React, { useMemo } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { FolderPlus, Pin } from 'lucide-react-native';
import type { ListDto } from '../../models/list';
import type { PinnedRepository } from '../../services/pinnedRepositoryCodec';
import type { RepositoryDetail } from '../../models/repository';
import { mapPinnedRepository } from '../../utils/repository-mapper';
import RepoCard from '../explore/RepoCard';
import { BoardListCard } from './BoardListCard';

type SectionQuery<T> = {
  data?: T;
  isPending: boolean;
  isError: boolean;
  isFetching?: boolean;
  refetch: () => unknown;
};

type Props = {
  viewer: string | undefined;
  header: React.ReactElement;
  compact: boolean;
  horizontalPadding: number;
  maxWidth: number;
  paddingTop: number;
  paddingBottom: number;
  boards?: SectionQuery<ListDto[]>;
  collections: SectionQuery<ListDto[]>;
  pinned: SectionQuery<PinnedRepository[]>;
  section?: 'Repositories' | 'Lists';
  openList: (params: Record<string, string>) => void;
  openRepository?: (repository: RepositoryDetail) => void;
};

type ListRow =
  | { key: string; kind: 'list'; item: ListDto }
  | { key: string; kind: 'repository'; item: RepositoryDetail }
  | { key: string; kind: 'state'; section: 'boards' | 'collections' | 'pinned' }
  | { key: string; kind: 'empty' };

export function ProfileContentLists(props: Props) {
  const { viewer, compact, boards, collections, pinned, openList, section = 'Lists' } = props;
  const boardItems = boards?.data;
  const collectionItems = collections.data;
  const pinnedItems = pinned.data;
  const boardsPending = boards?.isPending ?? false;
  const boardsError = boards?.isError ?? false;
  const collectionsPending = collections.isPending;
  const collectionsError = collections.isError;
  const pinnedPending = pinned.isPending;
  const pinnedError = pinned.isError;
  const gap = compact ? 10 : 13;
  const rows = useMemo(() => {
    if (!viewer) return [];
    const result: ListRow[] = [];
    if (section === 'Repositories') {
      const repositories = (pinnedItems ?? []).map(mapPinnedRepository).filter((repo): repo is RepositoryDetail => repo !== null);
      result.push(...repositories.map(item => ({key:`pinned:${item.id}`,kind:'repository' as const,item})));
      if (pinnedPending || pinnedError) result.push({key:'state:pinned',kind:'state',section:'pinned'});
      else if (repositories.length === 0) result.push({key:'empty',kind:'empty'});
      return result;
    }
    for (const [section, show] of [
      ['boards', boardsPending || boardsError],
      ['collections', collectionsPending || collectionsError],
    ] as const) {
      if (show) result.push({ key: `state:${section}`, kind: 'state', section });
    }
    const ready = [...(boardItems ?? []), ...(collectionItems ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    result.push(...ready.map(item => ({ key: `${item.source}:${item.id}`, kind: 'list' as const, item })));
    if ((boardItems?.length ?? 0) === 0 && collectionItems?.length === 0 && !boardsPending && !boardsError && !collectionsError) {
      result.push({ key: 'empty', kind: 'empty' });
    }
    return result;
  }, [viewer, section, boardItems, collectionItems, pinnedItems, boardsPending, boardsError, collectionsPending, collectionsError, pinnedPending, pinnedError]);

  const renderRow = ({ item: row }: { item: ListRow }) => {
    let content: React.ReactNode;
    if (row.kind === 'list') {
      const { item } = row;
      const params: Record<string, string> = item.source === 'legacy-board'
        ? { boardId: item.id, boardName: item.name }
        : { collectionId: item.id, collectionType: 'collection', boardName: item.name };
      content = <BoardListCard compact={compact} description={item.description} name={item.name} repositoryCount={item.repositoryCount}
        onPress={() => openList({ ...params, ...(item.description ? { boardDescription: item.description } : {}) })} />;
    } else if (row.kind === 'repository') {
      content = <RepoCard compact={compact} variant="profile" showMetrics={false} repo={row.item}
        onPress={() => props.openRepository?.(row.item)} />;
    } else if (row.kind === 'state') {
      const query = props[row.section];
      if (!query) return null;
      const label = row.section === 'pinned' ? 'pinned repositories' : 'Lists';
      const hasCachedData = query.data !== undefined;
      const message = query.isFetching
        ? `Refreshing ${label}…`
        : hasCachedData ? `Couldn’t refresh ${label}.` : `Unable to load your ${label}.`;
      content = <View style={{ minHeight: 70, alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 12 }}>
        {query.isPending ? <View accessible={true} accessibilityRole="progressbar" accessibilityLabel={`Loading ${label}`}
          accessibilityState={{ busy: true }} style={{ width: '100%', gap: 10 }}>
          {Array.from({ length: row.section === 'pinned' ? 1 : 2 }, (_, index) => <View key={index} accessible={false}
            style={{ minHeight: compact ? 70 : 84, borderRadius: 18, backgroundColor: '#1D1D1F', borderWidth: 1,
              borderColor: '#2F2F32', padding: 13, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: '#29292C' }} />
            <View style={{ flex: 1, gap: 9 }}>
              <View style={{ width: '65%', height: 14, borderRadius: 4, backgroundColor: '#29292C' }} />
              <View style={{ width: '40%', height: 10, borderRadius: 4, backgroundColor: '#29292C' }} />
            </View>
          </View>)}
        </View> : <>
          <Text accessibilityLiveRegion="polite" className="font-nata text-center"
            style={{ color: hasCachedData || query.isFetching ? '#8A898F' : '#FF6878' }}>{message}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Retry ${label}`} accessibilityState={{ busy: Boolean(query.isFetching), disabled: Boolean(query.isFetching) }}
            disabled={query.isFetching} onPress={() => { if (!query.isFetching) void query.refetch(); }} className="rounded-[12px] bg-[#292929] px-5 py-3">
            <Text className="text-white font-nataSemiBold">{query.isFetching ? 'Retrying…' : 'Retry'}</Text>
          </Pressable>
        </>}
      </View>;
    } else {
      content = <View className="items-center justify-center py-9 px-6 gap-4">
        <View className="w-[68px] h-[68px] rounded-[22px] bg-[#151515] border border-[#252525] items-center justify-center">
          {section === 'Repositories' ? <Pin size={29} color="#63E08A" strokeWidth={1.7} /> : <FolderPlus size={29} color="#63E08A" strokeWidth={1.7} />}
        </View>
        <Text className="text-[#F7F7F8] font-nataSemiBold text-center">{section === 'Repositories' ? 'No pinned repositories' : 'Create your first list'}</Text>
        <Text className="text-[#77767C] font-nata text-center">{section === 'Repositories' ? 'Repositories you pin will appear here.' : 'Lists you create while saving repositories will appear here.'}</Text>
      </View>;
    }
    return <View testID={`profile-list-${row.key}`} style={{ paddingBottom: gap }}>{content}</View>;
  };

  // One virtualized scroller owns the profile header and all Lists, including
  // independently ready sections. Never nest it inside a same-axis ScrollView.
  return <FlatList key={props.viewer} testID="profile-lists" style={{ flex: 1 }} data={rows} renderItem={renderRow} keyExtractor={row => row.key}
    initialNumToRender={8} maxToRenderPerBatch={8} windowSize={5}
    ListHeaderComponent={<View style={{ paddingBottom: gap }}>{props.header}
      {section === 'Repositories' ? <View style={{ flexDirection:'row',alignItems:'center',gap:8,paddingTop:18,paddingBottom:8 }}>
        <Pin size={17} color="#63E08A" /><Text style={{color:'#F7F7F8',fontFamily:'NataSans-Bold',fontSize:17}}>Pinned repositories</Text>
      </View> : null}
    </View>}
    showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="automatic"
    contentContainerStyle={{ paddingHorizontal: props.horizontalPadding, paddingTop: props.paddingTop, paddingBottom: props.paddingBottom,
      width: '100%', maxWidth: props.maxWidth + props.horizontalPadding * 2, alignSelf: 'center' }} />;
}
