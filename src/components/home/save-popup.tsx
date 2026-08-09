import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  createSaveCollection,
  getSaveCollections,
  saveRepositoryToCollections,
  type SaveCollection,
} from '@/api/repository-actions';
import { REFERENCE_THEME } from '@/constants/theme';
import { useModalScrollLock } from '@/hooks/use-modal-scroll-lock';
import { useAuth } from '@/store/AuthContext';
import * as SecureStore from '@/utils/storage';

type SavePopupProps = {
  isVisible: boolean;
  onClose: () => void;
  onSaved?: (saved: boolean) => void;
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

function collectionQueryKey(repositoryId?: string) {
  return ['save-collections', repositoryId] as const;
}

function CollectionLayoutPreview({ loading = false }: { loading?: boolean }) {
  return (
    <View style={styles.loadingList}>
      <View accessibilityLabel="Collection card layout" style={styles.skeletonGrid}>
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
        <View accessibilityLabel="Loading collections" accessibilityLiveRegion="polite" style={styles.previewLoadingOverlay}>
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
  repoId,
  repoName,
  serveId,
  position,
}: SavePopupProps) {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { checkOnboardingStatus } = useAuth();
  const queryClient = useQueryClient();
  const [modalHeight] = useState(height);
  const [translateY] = useState(() => new Animated.Value(height));
  const [overlayOpacity] = useState(() => new Animated.Value(0));
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createInputRef = useRef<TextInput>(null);
  const [search, setSearch] = useState('');
  const [localSelectedIds, setLocalSelectedIds] = useState<Set<string>>(new Set());
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useModalScrollLock(isVisible);

  const collectionsQuery = useQuery({
    queryKey: collectionQueryKey(repoId),
    queryFn: async ({ signal }) => {
      if (!repoId) throw new Error('Repository information is missing.');
      const token = await SecureStore.getItemAsync('access_token');
      if (!token) throw new Error('Sign in to manage repository collections.');
      return getSaveCollections(repoId, token, signal);
    },
    enabled: isVisible && Boolean(repoId),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: 1,
    retryDelay: 500,
  });

  const collections = useMemo(() => collectionsQuery.data ?? [], [collectionsQuery.data]);
  const serverSelectedIds = useMemo(
    () => new Set(collections.filter((collection) => collection.selected).map((collection) => collection.collection_id)),
    [collections],
  );
  const selectedIds = hasLocalChanges ? localSelectedIds : serverSelectedIds;
  const filteredCollections = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return collections;
    return collections.filter((collection) =>
      collection.name.toLocaleLowerCase().includes(query)
    );
  }, [collections, search]);
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
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: modalHeight,
        duration: 210,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(overlayOpacity, {
        toValue: 0,
        duration: 170,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (!finished) return;
      setSearch('');
      setMessage(null);
      setIsCreating(false);
      setNewCollectionName('');
      setLocalSelectedIds(new Set());
      setHasLocalChanges(false);
      onClose();
    });
  }, [modalHeight, onClose, overlayOpacity, translateY]);

  useEffect(() => {
    if (!isVisible) return;
    translateY.setValue(modalHeight);
    overlayOpacity.setValue(0);
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: 290,
        easing: Easing.bezier(0.32, 0.72, 0, 1),
        useNativeDriver: true,
      }),
      Animated.timing(overlayOpacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [isVisible, modalHeight, overlayOpacity, translateY]);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
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
    mutationFn: async () => {
      const name = newCollectionName.trim();
      if (!name) throw new Error('Collection name is required.');
      const token = await SecureStore.getItemAsync('access_token');
      if (!token) throw new Error('Sign in to create a collection.');
      return createSaveCollection({ name }, token);
    },
    onSuccess: async (collection) => {
      setHasLocalChanges(true);
      setLocalSelectedIds(new Set([...selectedIds, collection.collection_id]));
      setIsCreating(false);
      setNewCollectionName('');
      setMessage({ type: 'success', text: `${collection.name} created and selected.` });
      await haptic('success');
      await queryClient.invalidateQueries({ queryKey: collectionQueryKey(repoId) });
    },
    onError: (error) => setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Could not create collection.' }),
  });

  const saveMutation = useMutation({
    mutationFn: async (collectionIds: string[]) => {
      if (!repoId) throw new Error('Repository information is missing.');
      const token = await SecureStore.getItemAsync('access_token');
      if (!token) throw new Error('Sign in to save repositories.');
      return saveRepositoryToCollections(repoId, collectionIds, token, {
        serve_id: serveId,
        position,
      });
    },
    onMutate: async (collectionIds) => {
      const key = collectionQueryKey(repoId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SaveCollection[]>(key);
      queryClient.setQueryData<SaveCollection[]>(key, (current = []) => current.map((collection) => ({
        ...collection,
        selected: collectionIds.includes(collection.collection_id),
      })));
      return { previous };
    },
    onError: (error, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(collectionQueryKey(repoId), context.previous);
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Could not save repository.' });
    },
    onSuccess: async (result) => {
      setMessage({
        type: 'success',
        text: result.saved
          ? `Saved to ${result.collection_ids.length} ${result.collection_ids.length === 1 ? 'collection' : 'collections'}.`
          : 'Removed from collections.',
      });
      onSaved?.(result.saved);
      await haptic('success');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: collectionQueryKey(repoId) }),
        queryClient.invalidateQueries({ queryKey: ['savedRepos'] }),
        queryClient.invalidateQueries({ queryKey: ['profile-content'] }),
      ]);
      void checkOnboardingStatus().catch(() => undefined);
      setHasLocalChanges(false);
      closeTimer.current = setTimeout(closeAnimated, 900);
    },
  });

  const toggleCollection = (collectionId: string) => {
    setHasLocalChanges(true);
    setMessage(null);
    setLocalSelectedIds(() => {
      const next = new Set(selectedIds);
      if (next.has(collectionId)) next.delete(collectionId);
      else next.add(collectionId);
      return next;
    });
    void haptic();
  };

  const beginCollectionCreation = () => {
    setMessage(null);
    setIsCreating(true);
    void haptic();
  };

  const saveDisabled = saveMutation.isPending
    || collectionsQuery.isLoading
    || collectionsQuery.isFetching
    || collectionsQuery.isError;

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

        <KeyboardAvoidingView
          behavior="padding"
          enabled={process.env.EXPO_OS === 'ios'}
          pointerEvents="box-none"
          style={styles.keyboardLayer}
        >
          <Animated.View
            style={[
              styles.sheet,
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
            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text style={[styles.title, { color: palette.text }]}>Save repository</Text>
                <Text numberOfLines={1} style={[styles.subtitle, { color: palette.secondary }]}>
                  {repoName ? `Add ${repoName} to one or more collections` : 'Choose one or more collections'}
                </Text>
              </View>
              <Pressable accessibilityLabel="Close" accessibilityRole="button" hitSlop={8} onPress={closeAnimated} style={[styles.closeButton, { backgroundColor: palette.elevated }]}>
                <X color={palette.secondary} size={18} />
              </Pressable>
            </View>

            <View style={[styles.search, { backgroundColor: palette.elevated, borderColor: palette.border }]}>
              <Search color={palette.tertiary} size={19} />
              <TextInput
                accessibilityLabel="Search collections"
                onChangeText={setSearch}
                placeholder="Search collections"
                placeholderTextColor={palette.tertiary}
                style={[styles.searchInput, { color: palette.text }]}
                value={search}
              />
              {search ? (
                <Pressable accessibilityLabel="Clear search" accessibilityRole="button" hitSlop={8} onPress={() => setSearch('')}>
                  <X color={palette.tertiary} size={17} />
                </Pressable>
              ) : null}
            </View>

            <ScrollView
              bounces={false}
              contentContainerStyle={styles.collectionList}
              contentInsetAdjustmentBehavior="automatic"
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              overScrollMode="never"
              scrollEnabled
              showsVerticalScrollIndicator
              style={styles.collectionScroller}
            >
              {collectionsQuery.isLoading && collections.length === 0 ? (
                <CollectionLayoutPreview loading />
              ) : collectionsQuery.isError && collections.length === 0 ? (
                <CollectionLayoutPreview />
              ) : filteredCollections.length ? (
                <>
                  <View style={styles.collectionGrid}>
                    {filteredCollections.map((collection) => {
                      const selected = selectedIds.has(collection.collection_id);
                      const accent = collection.color || palette.accent;
                      return (
                        <View
                          key={collection.collection_id}
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
                                {collection.icon ? (
                                  <Text style={styles.emoji}>{collection.icon}</Text>
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
                              <Text numberOfLines={1} style={[styles.collectionName, { color: palette.text }]}>{collection.name}</Text>
                              <Text numberOfLines={1} style={[styles.collectionMeta, { color: palette.secondary }]}>
                                {collection.repo_count} {collection.repo_count === 1 ? 'repository' : 'repositories'}
                              </Text>
                            </View>
                          </View>
                          <Pressable
                            accessibilityLabel={`${collection.name}, ${collection.repo_count} repositories`}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: selected }}
                            onPress={() => toggleCollection(collection.collection_id)}
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
                    {search ? 'No matching collections' : 'Create your first collection'}
                  </Text>
                  <Text style={[styles.stateBody, { color: palette.secondary }]}>
                    {search ? 'Try another search term.' : 'Organize repositories by project, topic, or inspiration.'}
                  </Text>
                </View>
              )}
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
                      New collection
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel="Create new collection"
                    accessibilityRole="button"
                    onPress={beginCollectionCreation}
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
                    {saveMutation.isPending ? <ActivityIndicator color={palette.saveAccentText} /> : (
                      <Text style={[styles.saveText, { color: palette.saveAccentText }]}>Save</Text>
                    )}
                  </View>
                  <Pressable
                    accessibilityLabel="Save repository to selected collections"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: saveDisabled }}
                    disabled={saveDisabled}
                    onPress={() => saveMutation.mutate([...selectedIds])}
                    style={StyleSheet.absoluteFill}
                  />
                </View>
              </View>
            </View>

            {isCreating ? (
              <View accessibilityViewIsModal style={styles.creationOverlay}>
                <BlurView intensity={18} tint="dark" style={StyleSheet.absoluteFill} />
                <Pressable
                  accessibilityLabel="Cancel collection creation"
                  accessibilityRole="button"
                  disabled={createMutation.isPending}
                  onPress={() => { setIsCreating(false); setNewCollectionName(''); setMessage(null); }}
                  style={[StyleSheet.absoluteFill, styles.creationDim]}
                />
                <View style={[styles.createPanel, { backgroundColor: palette.elevatedStrong, borderColor: palette.border }]}>
                  <View style={styles.createHeader}>
                    <View style={styles.createHeading}>
                      <Text style={[styles.createTitle, { color: palette.text }]}>New collection</Text>
                      <Text style={[styles.createSubtitle, { color: palette.secondary }]}>Give this collection a clear name.</Text>
                    </View>
                    <Pressable
                      accessibilityLabel="Cancel collection creation"
                      accessibilityRole="button"
                      disabled={createMutation.isPending}
                      hitSlop={8}
                      onPress={() => { setIsCreating(false); setNewCollectionName(''); setMessage(null); }}
                      style={[styles.createClose, { backgroundColor: palette.elevated }]}
                    >
                      <X color={palette.secondary} size={18} />
                    </Pressable>
                  </View>
                  <TextInput
                    accessibilityLabel="Collection name"
                    editable={!createMutation.isPending}
                    ref={createInputRef}
                    maxLength={100}
                    onChangeText={(value) => { setNewCollectionName(value); if (message) setMessage(null); }}
                    onSubmitEditing={() => { if (newCollectionName.trim() && !createMutation.isPending) createMutation.mutate(); }}
                    placeholder="Collection name"
                    placeholderTextColor={palette.tertiary}
                    returnKeyType="done"
                    style={[styles.createInput, { backgroundColor: palette.elevated, color: palette.text, borderColor: palette.border }]}
                    value={newCollectionName}
                  />
                  {message?.type === 'error' ? (
                    <Text accessibilityLiveRegion="polite" selectable style={[styles.createError, { color: palette.danger }]}>{message.text}</Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !newCollectionName.trim() || createMutation.isPending }}
                    disabled={!newCollectionName.trim() || createMutation.isPending}
                    onPress={() => createMutation.mutate()}
                    style={({ pressed }) => [
                      styles.createSubmit,
                      { backgroundColor: palette.saveAccent },
                      (!newCollectionName.trim() || createMutation.isPending) && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    {createMutation.isPending ? <ActivityIndicator color={palette.saveAccentText} /> : (
                      <Text style={[styles.createSubmitText, { color: palette.saveAccentText }]}>Create</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : null}
          </Animated.View>
        </KeyboardAvoidingView>
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
  collectionScroller: { flex: 1 },
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
