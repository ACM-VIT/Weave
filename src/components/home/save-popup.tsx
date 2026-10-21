import { useReducedMotion } from 'react-native-reanimated';
import { KeyboardSurface } from '@/components/keyboard/keyboard-layout';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Check,
  CheckCircle2,
  FolderHeart,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react-native';

import {
  createRepositoryList,
  getRepositoryLists,
  listMembershipKey,
  repositoryListsQueryKey,
  syncRepositoryLists,
  type ListDto,
} from '@/api/lists';
import { prepareQueuedActivity, toInteractionEventV2 } from '@/api/activity';
import { repositoryDetailQueryKey } from '@/api/repositories';
import type { FeedPage } from '@/api/feed';
import type { RepositoryDetail } from '@/models/repository';
import { REFERENCE_THEME } from '@/constants/theme';
import { useModalScrollLock } from '@/hooks/use-modal-scroll-lock';
import { useAuth } from '@/store/AuthContext';
import { feedQueryKey, patchFeedSaved } from '@/utils/feed-repository';
import { listRepositoryQueryKey } from '@/services/accountQueryCache';
import * as SecureStore from '@/utils/storage';

export type SavePopupMutationState = { save: boolean; create: boolean };

type SavePopupProps = {
  mutations?: {
    state: SavePopupMutationState;
    onChange: React.Dispatch<React.SetStateAction<SavePopupMutationState>>;
  };
  isVisible: boolean;
  onClose: () => void;
  onSaved?: (saved: boolean, saveStateChanged: boolean) => void;
  onListMembershipsChanged?: (listIds: string[], saved: boolean) => void;
  repoId?: string;
  repoName?: string;
  serveId?: string | null;
  position?: number | null;
};

const SHEET_HORIZONTAL_MARGIN = 24;
const SHEET_MAX_WIDTH = 480;
const COLLECTION_GRID_GAP = 14;

const palette = {
  background: REFERENCE_THEME.surface,
  elevated: '#242426',
  elevatedStrong: REFERENCE_THEME.surfaceElevated,
  border: REFERENCE_THEME.border,
  text: REFERENCE_THEME.text,
  secondary: REFERENCE_THEME.textSecondary,
  tertiary: REFERENCE_THEME.textTertiary,
  accent: REFERENCE_THEME.accent,
  accentText: '#07130A',
  saveAccent: '#63E08A',
  saveAccentText: '#071009',
  overlay: 'rgba(0,0,0,0.70)',
  danger: REFERENCE_THEME.danger,
};

function ListLayoutPreview({ loading = false }: { loading?: boolean }) {
  return (
    <View style={styles.loadingList}>
      <View accessibilityLabel="List card layout" style={styles.skeletonGrid}>
        {[0, 1, 2, 3].map((item) => (
          <View key={item} style={[styles.skeleton, { backgroundColor: palette.elevated, borderColor: palette.border }]}>
            <View style={styles.skeletonTopRow}>
              <View style={[styles.skeletonIcon, { backgroundColor: palette.elevatedStrong }]} />
              <View style={[styles.skeletonCheck, { borderColor: palette.tertiary }]} />
            </View>
            <View style={[styles.skeletonLine, { backgroundColor: palette.elevatedStrong }]} />
            <View style={[styles.skeletonLineShort, { backgroundColor: palette.elevatedStrong }]} />
          </View>
        ))}
      </View>
      {loading ? (
        <View accessibilityLabel="Loading Lists" accessibilityLiveRegion="polite" style={styles.previewLoadingOverlay}>
          <ActivityIndicator color={palette.accent} size="small" />
        </View>
      ) : null}
    </View>
  );
}

export function SavePopup({
  isVisible,
  onClose,
  onSaved,
  onListMembershipsChanged,
  repoId,
  repoName,
  serveId,
  position,
  mutations,
}: SavePopupProps) {
  const { height, width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { checkOnboardingStatus, user } = useAuth();
  const viewerUserId = user?.user_id;
  const selectionScope = `${viewerUserId ?? 'anonymous'}:${repoId ?? 'missing'}`;
  const queryClient = useQueryClient();
  const [modalHeight] = useState(height);
  const [translateY] = useState(() => new Animated.Value(height));
  const [overlayOpacity] = useState(() => new Animated.Value(0));
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<TextInput>(null);
  const createInputRef = useRef<TextInput>(null);
  const [search, setSearch] = useState('');
  const [localSelection, setLocalSelection] = useState(() => ({
    scope: selectionScope,
    selectedIds: new Set<string>(),
    hasChanges: false,
  }));
  const [isCreating, setIsCreating] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [localMutations, setLocalMutations] = useState<SavePopupMutationState>({ save: false, create: false });
  const pending = mutations?.state ?? localMutations;
  const setPending = mutations?.onChange ?? setLocalMutations;
  const mountedRef = useRef(false);

  useModalScrollLock(isVisible);

  const listsQuery = useQuery({
    queryKey: repositoryListsQueryKey(repoId, viewerUserId),
    queryFn: async ({ signal }) => {
      if (!repoId) throw new Error('Repository information is missing.');
      const token = await SecureStore.getItemAsync('access_token');
      if (!token) throw new Error('Sign in to manage repository Lists.');
      return getRepositoryLists(repoId, token, signal);
    },
    enabled: isVisible && Boolean(repoId && viewerUserId),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: 1,
    retryDelay: 500,
  });

  const lists = useMemo(() => listsQuery.data ?? [], [listsQuery.data]);
  const serverSelectedIds = useMemo(
    () => new Set(lists.filter((list) => list.selected).map(listMembershipKey)),
    [lists],
  );
  const hasLocalChanges = localSelection.scope === selectionScope
    && localSelection.hasChanges;
  const selectedIds = hasLocalChanges ? localSelection.selectedIds : serverSelectedIds;
  const filteredLists = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return lists;
    return lists.filter((list) =>
      list.name.toLocaleLowerCase().includes(query)
    );
  }, [lists, search]);
  const sheetWidth = Math.min(Math.max(width - SHEET_HORIZONTAL_MARGIN, 0), SHEET_MAX_WIDTH);
  const sheetHeight = Math.min(460, modalHeight * 0.82);

  const haptic = useCallback(async (kind: 'selection' | 'success' = 'selection') => {
    if (process.env.EXPO_OS === 'web') return;
    if (kind === 'success') {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } else {
      await Haptics.selectionAsync().catch(() => undefined);
    }
  }, []);

  const closeAnimated = useCallback(() => {
    Keyboard.dismiss();
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: modalHeight,
        duration: reducedMotion ? 0 : 210,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(overlayOpacity, {
        toValue: 0,
        duration: reducedMotion ? 0 : 170,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (!finished || !mountedRef.current) return;
      setSearch('');
      setMessage(null);
      setIsCreating(false);
      setNewListName('');
      setLocalSelection({ scope: selectionScope, selectedIds: new Set(), hasChanges: false });
      onClose();
    });
  }, [modalHeight, onClose, overlayOpacity, selectionScope, translateY, reducedMotion]);

  useEffect(() => {
    if (!isVisible) return;
    translateY.setValue(modalHeight);
    overlayOpacity.setValue(0);
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: reducedMotion ? 0 : 290,
        easing: Easing.bezier(0.32, 0.72, 0, 1),
        useNativeDriver: true,
      }),
      Animated.timing(overlayOpacity, {
        toValue: 1,
        duration: reducedMotion ? 0 : 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [isVisible, modalHeight, overlayOpacity, translateY, reducedMotion]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!isCreating) {
      createInputRef.current?.blur();
      return;
    }
    const focusTimer = setTimeout(() => createInputRef.current?.focus(), 180);
    return () => clearTimeout(focusTimer);
  }, [isCreating]);

  const createMutation = useMutation({
    onMutate: () => setPending(current => ({ ...current, create: true })),
    mutationFn: async () => {
      const name = newListName.trim();
      if (!name) throw new Error('List name is required.');
      const token = await SecureStore.getItemAsync('access_token');
      if (!token) throw new Error('Sign in to create a List.');
      return createRepositoryList({ name }, token);
    },
    onSuccess: async (list) => {
      setLocalSelection({
        scope: selectionScope,
        selectedIds: new Set([...selectedIds, listMembershipKey(list)]),
        hasChanges: true,
      });
      setIsCreating(false);
      setNewListName('');
      setMessage({ type: 'success', text: `${list.name} created and selected.` });
      await haptic('success');
      await queryClient.invalidateQueries({
        queryKey: repositoryListsQueryKey(repoId, viewerUserId),
      });
    },
    onError: (error) => setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Could not create List.' }),
    onSettled: () => setPending(current => ({ ...current, create: false })),
  });

  const saveMutation = useMutation({
    mutationFn: async ({
      listIds,
      event,
    }: {
      listIds: string[];
      event: ReturnType<typeof toInteractionEventV2>;
    }) => {
      if (!repoId) throw new Error('Repository information is missing.');
      const token = await SecureStore.getItemAsync('access_token');
      if (!token) throw new Error('Sign in to save repositories.');
      return syncRepositoryLists(repoId, listIds, token, event);
    },
    onMutate: async ({ listIds }) => {
      setPending(current => ({ ...current, save: true }));
      const key = repositoryListsQueryKey(repoId, viewerUserId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ListDto[]>(key);
      queryClient.setQueryData<ListDto[]>(key, (current = []) => current.map((list) => ({
        ...list,
        selected: listIds.includes(listMembershipKey(list)),
      })));
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          repositoryListsQueryKey(repoId, viewerUserId),
          context.previous,
        );
      }
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Could not save repository.' });
    },
    onSuccess: async (result, _input, context) => {
      const previouslySelectedLists = context?.previous
        ?.filter((list) => list.selected)
        ?? [];
      const selectedLists = lists.filter((list) => result.selectedListIds.includes(listMembershipKey(list)));
      const changedLists = [...new Map(
        [...previouslySelectedLists, ...selectedLists]
          .map((list) => [listMembershipKey(list), list]),
      ).values()];
      setMessage({
        type: 'success',
        text: result.saved
          ? `Saved to ${result.selectedListIds.length} ${result.selectedListIds.length === 1 ? 'List' : 'Lists'}.`
          : 'Removed from Lists.',
      });
      if (repoId) {
        queryClient.setQueryData<RepositoryDetail>(
          repositoryDetailQueryKey(repoId, viewerUserId),
          (current) => current ? {
            ...current,
            selectedListIds: result.selectedListIds,
            viewerSaved: result.saved,
          } : current,
        );
        queryClient.setQueryData<InfiniteData<FeedPage, string | null>>(
          feedQueryKey(viewerUserId),
          (current) => patchFeedSaved(current, { repoId }, result.saved),
        );
      }
      onSaved?.(result.saved, result.saveStateChanged);
      onListMembershipsChanged?.(result.selectedListIds, result.saved);
      await haptic('success');
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: repositoryListsQueryKey(repoId, viewerUserId),
        }),
        queryClient.invalidateQueries({
          queryKey: repositoryDetailQueryKey(repoId ?? '', viewerUserId),
          refetchType: 'none',
        }),
        queryClient.invalidateQueries({
          queryKey: ['savedRepos', viewerUserId],
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: ['profile-stat-repositories', 'saved', viewerUserId],
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: ['profile-content', viewerUserId],
          exact: true,
        }),
        ...changedLists.map((list) => queryClient.invalidateQueries({
          queryKey: listRepositoryQueryKey(
            list.source === 'collection' ? 'collection' : 'board',
            viewerUserId,
            list.id,
          ),
        })),
      ]);
      void checkOnboardingStatus().catch(() => undefined);
      setLocalSelection({
        scope: selectionScope,
        selectedIds: new Set(result.selectedListIds),
        hasChanges: false,
      });
      if (mountedRef.current) closeTimer.current = setTimeout(closeAnimated, 900);
    },
    onSettled: () => setPending(current => ({ ...current, save: false })),
  });

  const isSaving = saveMutation.isPending || pending.save;
  const isCreatingList = createMutation.isPending || pending.create;
  const mutationBusy = isSaving || isCreatingList;

  const toggleList = (listId: string) => {
    if (mutationBusy) return;
    setMessage(null);
    const next = new Set(selectedIds);
    if (next.has(listId)) next.delete(listId);
    else next.add(listId);
    setLocalSelection({ scope: selectionScope, selectedIds: next, hasChanges: true });
    void haptic();
  };

  const beginListCreation = () => {
    if (mutationBusy) return;
    setMessage(null);
    setIsCreating(true);
    void haptic();
  };

  const saveDisabled = mutationBusy
    || listsQuery.isLoading
    || listsQuery.isFetching
    || listsQuery.isError;

  if (!isVisible) return null;

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={closeAnimated}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <View style={styles.root}>
        <Pressable accessibilityLabel="Close save sheet" accessibilityRole="button" onPress={closeAnimated} style={StyleSheet.absoluteFill}>
          <Animated.View style={[styles.overlay, { backgroundColor: palette.overlay, opacity: overlayOpacity }]}>
            <BlurView intensity={22} tint="dark" style={StyleSheet.absoluteFill} />
          </Animated.View>
        </Pressable>

        <KeyboardSurface
          pointerEvents="box-none"
          style={[styles.keyboardLayer, { paddingTop: insets.top }]}
        >
          <Animated.View
            style={[
              styles.sheet,
              { flexShrink: 1, minHeight: 0 },
              {
                backgroundColor: palette.background,
                borderColor: palette.border,
                height: sheetHeight,
                marginBottom: Math.max(insets.bottom, 12),
                transform: [{ translateY }],
                width: sheetWidth,
              },
            ]}
          >
            <View style={{ flex: 1, minHeight: 0 }} accessibilityElementsHidden={isCreating} importantForAccessibility={isCreating ? "no-hide-descendants" : "auto"}>
            <ScrollView style={{ flex: 1, minHeight: 0 }} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text style={[styles.title, { color: palette.text }]}>Save repository</Text>
                <Text numberOfLines={1} style={[styles.subtitle, { color: palette.secondary }]}>
                  {repoName ? `Add ${repoName} to one or more Lists` : 'Choose one or more Lists'}
                </Text>
              </View>
              <Pressable accessibilityLabel="Close" accessibilityRole="button" hitSlop={14} onPress={closeAnimated} style={[styles.closeButton, { backgroundColor: palette.elevated }]}>
                <X color={palette.secondary} size={18} />
              </Pressable>
            </View>

            <View style={[styles.search, { backgroundColor: palette.elevated, borderColor: palette.border }]}>
              <Search color={palette.tertiary} size={19} />
              <TextInput
                ref={searchInputRef}
                accessibilityLabel="Search Lists"
                onChangeText={setSearch}
                placeholder="Search Lists"
                placeholderTextColor={palette.secondary}
                style={[styles.searchInput, { color: palette.text }]}
                value={search}
              />
              {search ? (
                <Pressable accessibilityLabel="Clear search" accessibilityRole="button" hitSlop={14} onPress={() => { setSearch(''); searchInputRef.current?.focus(); }}>
                  <X color={palette.tertiary} size={17} />
                </Pressable>
              ) : null}
            </View>

            <View style={styles.collectionList}>
              {listsQuery.isLoading && lists.length === 0 ? (
                <ListLayoutPreview loading />
              ) : listsQuery.isError && lists.length === 0 ? (
                <ListLayoutPreview />
              ) : filteredLists.length ? (
                <>
                  <View style={styles.collectionGrid}>
                    {filteredLists.map((list) => {
                      const membershipId = listMembershipKey(list);
                      const selected = selectedIds.has(membershipId);
                      const accent = list.color || palette.accent;
                      return (
                        <View
                          key={membershipId}
                          style={[
                            styles.collectionCard,
                            {
                              backgroundColor: selected ? `${accent}16` : palette.elevated,
                              borderColor: selected ? accent : palette.border,
                            },
                          ]}
                        >
                          <View pointerEvents="none" style={styles.collectionCardContent}>
                            <View style={styles.collectionTopRow}>
                              <View style={[styles.collectionIcon, { backgroundColor: `${accent}20` }]}>
                                {list.icon ? (
                                  <Text style={styles.emoji}>{list.icon}</Text>
                                ) : (
                                  <FolderHeart color={accent} size={18} />
                                )}
                              </View>
                              <Animated.View style={[
                                styles.checkbox,
                                { backgroundColor: selected ? accent : 'transparent', borderColor: selected ? accent : palette.tertiary },
                              ]}>
                                {selected ? <Check color="#101510" size={13} strokeWidth={3} /> : null}
                              </Animated.View>
                            </View>
                            <View style={styles.collectionCopy}>
                              <Text numberOfLines={1} style={[styles.collectionName, { color: palette.text }]}>{list.name}</Text>
                              <Text numberOfLines={1} style={[styles.collectionMeta, { color: palette.secondary }]}>
                                {list.repositoryCount} {list.repositoryCount === 1 ? 'repository' : 'repositories'}
                              </Text>
                            </View>
                          </View>
                          <Pressable
                            accessibilityLabel={`${list.name}, ${list.repositoryCount} repositories`}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: selected, disabled: mutationBusy }}
                            disabled={mutationBusy}
                            onPress={() => toggleList(membershipId)}
                            style={StyleSheet.absoluteFill}
                          />
                        </View>
                      );
                    })}
                  </View>
                </>
              ) : (
                <View style={styles.centerState}>
                  <Sparkles color={palette.accent} size={30} />
                  <Text style={[styles.stateTitle, { color: palette.text }]}>
                    {search ? 'No matching Lists' : 'Create your first List'}
                  </Text>
                  <Text style={[styles.stateBody, { color: palette.secondary }]}>
                    {search ? 'Try another search term.' : 'Organize repositories by project, topic, or inspiration.'}
                  </Text>
                </View>
              )}
            </View>
            </ScrollView>

            <View style={[styles.footer, { borderTopColor: palette.border, backgroundColor: palette.background }]}>
              {message ? (
                <View accessibilityLiveRegion="polite" style={styles.messageRow}>
                  {message.type === 'success' ? <CheckCircle2 color={palette.accent} size={17} /> : <X color={palette.danger} size={17} />}
                  <Text selectable style={[styles.messageText, { color: message.type === 'success' ? palette.accent : palette.danger }]}>{message.text}</Text>
                </View>
              ) : null}

              <View style={styles.footerActions}>
                <View
                  style={[
                    styles.newButtonFrame,
                    {
                      backgroundColor: palette.elevatedStrong,
                      borderColor: '#55555A',
                    },
                  ]}
                >
                  <View
                    pointerEvents="none"
                    style={{
                      flex: 1,
                      minHeight: 44,
                      paddingHorizontal: 10,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 7,
                    }}
                  >
                    <Plus color={palette.accent} size={18} strokeWidth={2.4} />
                    <Text numberOfLines={1} style={[styles.newButtonText, { color: palette.text }]}>
                      New List
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel="Create new List"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: mutationBusy }}
                    disabled={mutationBusy}
                    onPress={beginListCreation}
                    style={StyleSheet.absoluteFill}
                  />
                </View>

                <View
                  style={[
                    styles.saveButtonFrame,
                    { backgroundColor: palette.saveAccent },
                    saveDisabled && styles.disabled,
                  ]}
                >
                  <View
                    pointerEvents="none"
                    style={{
                      flex: 1,
                      minHeight: 44,
                      paddingHorizontal: 12,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {isSaving ? <ActivityIndicator color={palette.saveAccentText} /> : (
                      <Text style={[styles.saveText, { color: palette.saveAccentText }]}>Save</Text>
                    )}
                  </View>
                  <Pressable
                    accessibilityLabel="Save repository to selected Lists"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: saveDisabled }}
                    disabled={saveDisabled}
                    onPress={() => {
                      if (!repoId || saveDisabled) return;
                      const event = toInteractionEventV2(prepareQueuedActivity({
                        repo_id: repoId,
                        action: selectedIds.size > 0 ? 'save' : 'unsave',
                        serve_id: serveId ?? null,
                        position: position ?? null,
                      }));
                      saveMutation.mutate({ listIds: [...selectedIds], event });
                    }}
                    style={StyleSheet.absoluteFill}
                  />
                </View>
              </View>
            </View>

            </View>
            {isCreating ? (
              <View accessibilityViewIsModal style={styles.creationOverlay}>
                <BlurView intensity={18} tint="dark" style={StyleSheet.absoluteFill} />
                <Pressable
                  accessibilityLabel="Cancel List creation"
                  accessibilityRole="button"
                  disabled={mutationBusy}
                  onPress={() => { setIsCreating(false); setNewListName(''); setMessage(null); }}
                  style={[StyleSheet.absoluteFill, styles.creationDim]}
                />
                <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" style={{ maxHeight: "100%", width: "100%", maxWidth: 350 }} contentContainerStyle={[styles.createPanel, { backgroundColor: palette.elevatedStrong, borderColor: palette.border }]}>
                  <View style={styles.createHeader}>
                    <View style={styles.createHeading}>
                      <Text style={[styles.createTitle, { color: palette.text }]}>New List</Text>
                      <Text style={[styles.createSubtitle, { color: palette.secondary }]}>Give this List a clear name.</Text>
                    </View>
                    <Pressable
                      accessibilityLabel="Cancel List creation"
                      accessibilityRole="button"
                      disabled={mutationBusy}
                      hitSlop={14}
                      onPress={() => { setIsCreating(false); setNewListName(''); setMessage(null); }}
                      style={[styles.createClose, { backgroundColor: palette.elevated }]}
                    >
                      <X color={palette.secondary} size={18} />
                    </Pressable>
                  </View>
                  <TextInput
                    accessibilityLabel="List name"
                    editable={!mutationBusy}
                    ref={createInputRef}
                    maxLength={100}
                    onChangeText={(value) => { setNewListName(value); if (message) setMessage(null); }}
                    onSubmitEditing={() => { if (newListName.trim() && !mutationBusy) createMutation.mutate(); }}
                    placeholder="List name"
                    placeholderTextColor={palette.secondary}
                    returnKeyType="done"
                    style={[styles.createInput, { backgroundColor: palette.elevated, color: palette.text, borderColor: palette.border }]}
                    value={newListName}
                  />
                  {message?.type === 'error' ? (
                    <Text accessibilityLiveRegion="polite" selectable style={[styles.createError, { color: palette.danger }]}>{message.text}</Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !newListName.trim() || mutationBusy }}
                    disabled={!newListName.trim() || mutationBusy}
                    onPress={() => { if (newListName.trim() && !mutationBusy) createMutation.mutate(); }}
                    style={({ pressed }) => [
                      styles.createSubmit,
                      { backgroundColor: palette.saveAccent },
                      (!newListName.trim() || mutationBusy) && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    {isCreatingList ? <ActivityIndicator color={palette.saveAccentText} /> : (
                      <Text style={[styles.createSubmitText, { color: palette.saveAccentText }]}>Create</Text>
                    )}
                  </Pressable>
                </ScrollView>
              </View>
            ) : null}
          </Animated.View>
        </KeyboardSurface>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  overlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
  keyboardLayer: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  sheet: { borderRadius: 26, borderWidth: 1, overflow: 'hidden', boxShadow: '0 22px 64px rgba(0,0,0,0.48)' },
  header: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 11, flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerText: { flex: 1, gap: 3 },
  title: { fontFamily: 'NataSans-Bold', fontSize: 19, lineHeight: 24 },
  subtitle: { fontFamily: 'NataSans-Regular', fontSize: 12, lineHeight: 16 },
  closeButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  search: { minHeight: 43, marginHorizontal: 14, borderWidth: 1, borderRadius: 13, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchInput: { flex: 1, minHeight: 41, fontFamily: 'NataSans-Regular', fontSize: 13 },
  collectionList: { padding: 14, gap: 9 },
  loadingList: { minHeight: 190, position: 'relative' },
  previewLoadingOverlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(29,29,31,0.34)' },
  skeletonGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: COLLECTION_GRID_GAP },
  skeleton: { width: '30%', minHeight: 108, flexGrow: 0, flexShrink: 0, borderWidth: 1, borderRadius: 15, padding: 10, gap: 8 },
  skeletonTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  skeletonIcon: { width: 32, height: 32, borderRadius: 10 },
  skeletonCheck: { width: 20, height: 20, borderWidth: 1.4, borderRadius: 7 },
  skeletonLine: { width: '72%', height: 9, borderRadius: 5 },
  skeletonLineShort: { width: '48%', height: 7, borderRadius: 4 },
  collectionGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: COLLECTION_GRID_GAP },
  collectionCard: { width: '31.5%', minHeight: 92, flexGrow: 0, flexShrink: 0, borderWidth: 1.2, borderRadius: 16, overflow: 'hidden', boxShadow: '0 4px 14px rgba(0,0,0,0.18)' },
  collectionCardContent: { flex: 1, padding: 10, gap: 7 },
  collectionTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  collectionIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 17 },
  collectionCopy: { gap: 1 },
  collectionName: { fontFamily: 'NataSans-SemiBold', fontSize: 13.5, lineHeight: 18 },
  collectionMeta: { fontFamily: 'NataSans-Regular', fontSize: 10.5, lineHeight: 14, fontVariant: ['tabular-nums'] },
  checkbox: { width: 20, height: 20, borderRadius: 7, borderWidth: 1.4, alignItems: 'center', justifyContent: 'center' },
  centerState: { minHeight: 174, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', gap: 8 },
  stateTitle: { fontFamily: 'NataSans-Bold', fontSize: 16, textAlign: 'center' },
  stateBody: { fontFamily: 'NataSans-Regular', fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
  footer: { borderTopWidth: 1, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 14, gap: 9 },
  footerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  newButtonFrame: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1.2,
    borderRadius: 13,
    overflow: 'hidden',
  },
  saveButtonFrame: {
    flex: 1.12,
    minHeight: 44,
    borderRadius: 13,
    overflow: 'hidden',
    boxShadow: '0 4px 14px rgba(48,209,88,0.28)',
  },
  newButtonText: { flexShrink: 1, fontFamily: 'NataSans-SemiBold', fontSize: 12.5 },
  creationOverlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, zIndex: 20, alignItems: 'center', justifyContent: 'center', padding: 18 },
  creationDim: { backgroundColor: 'rgba(4,6,4,0.78)' },
  createPanel: { width: '100%', maxWidth: 350, borderWidth: 1, borderRadius: 18, padding: 15, gap: 11, boxShadow: '0 18px 50px rgba(0,0,0,0.55)' },
  createHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  createHeading: { flex: 1, gap: 2 },
  createTitle: { fontFamily: 'NataSans-Bold', fontSize: 15 },
  createSubtitle: { fontFamily: 'NataSans-Regular', fontSize: 11, lineHeight: 15 },
  createClose: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  createInput: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontFamily: 'NataSans-Regular', fontSize: 13 },
  createError: { fontFamily: 'NataSans-Medium', fontSize: 11.5, lineHeight: 16 },
  createSubmit: { minHeight: 44, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  createSubmitText: { fontFamily: 'NataSans-SemiBold', fontSize: 13.5 },
  messageRow: { minHeight: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  messageText: { flexShrink: 1, fontFamily: 'NataSans-Medium', fontSize: 12, textAlign: 'center' },
  saveText: { fontFamily: 'NataSans-Bold', fontSize: 13.5 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.988 }] },
  disabled: { opacity: 0.5 },
});
