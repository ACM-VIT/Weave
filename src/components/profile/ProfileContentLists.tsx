import React, { useMemo } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { FolderPlus } from 'lucide-react-native';
import type { ListDto } from '../../models/list';
import { BoardListCard } from './BoardListCard';

type SectionQuery<T> = {
  data?: T;
  isPending: boolean;
  isError: boolean;
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
  boards: SectionQuery<ListDto[]>;
  collections: SectionQuery<ListDto[]>;
  pinned: SectionQuery<unknown[]>;
  openList: (params: Record<string, string>) => void;
};

type ListRow =
  | { key: string; kind: 'list'; item: ListDto }
  | { key: string; kind: 'pinned' }
  | { key: string; kind: 'state'; section: 'boards' | 'collections' | 'pinned' }
  | { key: string; kind: 'empty' };

export function ProfileContentLists(props: Props) {
  const { viewer, compact, boards, collections, pinned, openList } = props;
  const boardItems = boards.data;
  const collectionItems = collections.data;
  const pinnedItems = pinned.data;
  const boardsPending = boards.isPending;
  const boardsError = boards.isError;
  const collectionsPending = collections.isPending;
  const collectionsError = collections.isError;
  const pinnedPending = pinned.isPending;
  const pinnedError = pinned.isError;
  const gap = compact ? 10 : 13;
  const rows = useMemo(() => {
    if (!viewer) return [];
    const result: ListRow[] = [];
    if (pinnedItems) result.push({ key: 'pinned', kind: 'pinned' });
    for (const [section, show] of [
      ['pinned', pinnedPending || pinnedError],
      ['boards', boardsPending || boardsError],
      ['collections', collectionsPending || collectionsError],
    ] as const) {
      if (show) result.push({ key: `state:${section}`, kind: 'state', section });
    }
    const ready = [...(boardItems ?? []), ...(collectionItems ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    result.push(...ready.map(item => ({ key: `${item.source}:${item.id}`, kind: 'list' as const, item })));
    if (boardItems?.length === 0 && collectionItems?.length === 0 && !boardsError && !collectionsError) {
      result.push({ key: 'empty', kind: 'empty' });
    }
    return result;
  }, [viewer, boardItems, collectionItems, pinnedItems, boardsPending, boardsError, collectionsPending, collectionsError, pinnedPending, pinnedError]);

  const renderRow = ({ item: row }: { item: ListRow }) => {
    let content: React.ReactNode;
    if (row.kind === 'list') {
      const { item } = row;
      const params: Record<string, string> = item.source === 'legacy-board'
        ? { boardId: item.id, boardName: item.name }
        : { collectionId: item.id, collectionType: 'collection', boardName: item.name };
      content = <BoardListCard compact={compact} description={item.description} name={item.name} repositoryCount={item.repositoryCount}
        onPress={() => openList({ ...params, ...(item.description ? { boardDescription: item.description } : {}) })} />;
    } else if (row.kind === 'pinned') {
      content = <BoardListCard compact={compact} name="Pinned" variant="pinned" repositoryCount={pinned.data?.length ?? 0}
        onPress={() => openList({ boardName: 'Pinned', collectionType: 'pinned' })} />;
    } else if (row.kind === 'state') {
      const query = props[row.section];
      const label = row.section === 'pinned' ? 'pinned repositories' : 'Lists';
      content = <View style={{ minHeight: 70, alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 12 }}>
        {query.isPending ? <>
          <ActivityIndicator color="#63E08A" accessibilityLabel={`Loading ${label}`} />
          <Text className="text-[#77767C] font-nata">Loading {label}…</Text>
        </> : <>
          <Text accessibilityLiveRegion="polite" className="text-[#FF6878] font-nata text-center">Unable to load your {label}.</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Retry ${label}`} onPress={() => void query.refetch()} className="rounded-[12px] bg-[#292929] px-5 py-3">
            <Text className="text-white font-nataSemiBold">Retry</Text>
          </Pressable>
        </>}
      </View>;
    } else {
      content = <View className="items-center justify-center py-9 px-6 gap-4">
        <View className="w-[68px] h-[68px] rounded-[22px] bg-[#151515] border border-[#252525] items-center justify-center">
          <FolderPlus size={29} color="#63E08A" strokeWidth={1.7} />
        </View>
        <Text className="text-[#F7F7F8] font-nataSemiBold text-center">Create your first list</Text>
        <Text className="text-[#77767C] font-nata text-center">Lists you create while saving repositories will appear here.</Text>
      </View>;
    }
    return <View testID={`profile-list-${row.key}`} style={{ paddingBottom: gap }}>{content}</View>;
  };

  // One virtualized scroller owns the profile header and all Lists, including
  // independently ready sections. Never nest it inside a same-axis ScrollView.
  return <FlatList key={props.viewer} testID="profile-lists" style={{ flex: 1 }} data={rows} renderItem={renderRow} keyExtractor={row => row.key}
    initialNumToRender={8} maxToRenderPerBatch={8} windowSize={5}
    ListHeaderComponent={<View style={{ paddingBottom: gap }}>{props.header}</View>}
    showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="automatic"
    contentContainerStyle={{ paddingHorizontal: props.horizontalPadding, paddingTop: props.paddingTop, paddingBottom: props.paddingBottom,
      width: '100%', maxWidth: props.maxWidth + props.horizontalPadding * 2, alignSelf: 'center' }} />;
}
