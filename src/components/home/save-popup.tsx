import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Check, X } from 'lucide-react-native';
import { BlurView } from 'expo-blur';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { REFERENCE_THEME } from '@/constants/theme';
import { getUserBoards } from '../../api/boards';
import { useOptimisticMutations } from '../../hooks/useOptimisticMutations';
import { useAuth } from '../../store/AuthContext';
import * as SecureStore from '../../utils/storage';

interface SavePopupProps {
  isVisible: boolean;
  onClose: () => void;
  onSaved?: () => void;
  repoId?: string;
  repoName?: string;
  serveId?: string | null;
  position?: number | null;
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
  const { user } = useAuth();
  const { createBoardMutation, addRepoToBoardMutation } = useOptimisticMutations(user?.user_id);
  const translateY = useMemo(() => new Animated.Value(0), []);
  const overlayOpacity = useMemo(() => new Animated.Value(0), []);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newCollection, setNewCollection] = useState('');
  const [status, setStatus] = useState<'idle' | 'saved'>('idle');
  const [error, setError] = useState('');

  const { data: boardsData, isLoading: isLoadingBoards } = useInfiniteQuery({
    queryKey: ['boards', user?.user_id],
    queryFn: async ({ pageParam = 0 }) => {
      if (!user?.user_id) throw new Error('No user id');
      const token = await SecureStore.getItemAsync('access_token');
      if (!token) throw new Error('No token');
      return getUserBoards(user.user_id, token, 20, pageParam);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === 20 ? allPages.length * 20 : undefined,
    enabled: Boolean(user?.user_id && isVisible),
  });

  const collections = useMemo(() => boardsData?.pages.flat() ?? [], [boardsData]);
  const effectiveSelected = collections.some((board: any) => board.board_id === selected)
    ? selected
    : collections[0]?.board_id ?? null;
  const selectedBoard = collections.find((board: any) => board.board_id === effectiveSelected);
  const sheetHeight = Math.min(520, height * 0.75);

  useEffect(() => {
    if (!isVisible) return;
    translateY.setValue(sheetHeight);
    overlayOpacity.setValue(0);
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: 280,
        easing: Easing.bezier(0.32, 0.72, 0, 1),
        useNativeDriver: true,
      }),
      Animated.timing(overlayOpacity, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [isVisible, overlayOpacity, sheetHeight, translateY]);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const closeAnimated = () => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: sheetHeight,
        duration: 220,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(overlayOpacity, {
        toValue: 0,
        duration: 180,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) {
        setStatus('idle');
        setError('');
        setIsCreating(false);
        setNewCollection('');
        onClose();
      }
    });
  };

  const createCollection = () => {
    const name = newCollection.trim();
    if (!name || !user || createBoardMutation.isPending) return;
    setError('');
    createBoardMutation.mutate(name, {
      onSuccess: (board: any) => {
        setIsCreating(false);
        setNewCollection('');
        if (board?.board_id) setSelected(board.board_id);
      },
      onError: (mutationError: any) => {
        setError(mutationError?.message || 'Could not create collection.');
      },
    });
  };

  const saveRepository = () => {
    if (!effectiveSelected || !repoId || !repoName || addRepoToBoardMutation.isPending) return;
    setError('');
    addRepoToBoardMutation.mutate(
      { boardId: effectiveSelected, repoId, repoName, serveId, position },
      {
        onSuccess: () => {
          setStatus('saved');
          onSaved?.();
          closeTimer.current = setTimeout(closeAnimated, 450);
        },
        onError: (mutationError: any) => {
          setError(mutationError?.message || 'Could not save this repository.');
        },
      }
    );
  };

  if (!isVisible) return null;

  const saveDisabled = !effectiveSelected || addRepoToBoardMutation.isPending;

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={closeAnimated}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={isVisible}
    >
    <View style={styles.root}>
      <Pressable accessibilityLabel="Close save sheet" style={StyleSheet.absoluteFill} onPress={closeAnimated}>
        <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
          <BlurView intensity={12} tint="dark" style={StyleSheet.absoluteFill} />
        </Animated.View>
      </Pressable>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardLayer}
        pointerEvents="box-none"
      >
        <Animated.View
          style={[
            styles.sheet,
            {
              width: Math.min(width, 520),
              maxHeight: sheetHeight,
              paddingBottom: Math.max(insets.bottom, 28),
              transform: [{ translateY }],
            },
          ]}
        >
          <View style={styles.grabberWrap}>
            <View style={styles.grabber} />
          </View>

          <View style={styles.content}>
            <View style={styles.header}>
              <View style={styles.headerCopy}>
                <Text style={styles.title}>Save repository</Text>
                <Text style={styles.subtitle}>Choose a collection</Text>
              </View>
              <Pressable
                accessibilityLabel="Close"
                accessibilityRole="button"
                onPress={closeAnimated}
                style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
              >
                <X size={12} color="rgba(235,235,245,0.70)" strokeWidth={2.6} />
              </Pressable>
            </View>

            <ScrollView
              style={styles.collectionList}
              contentContainerStyle={styles.collectionListContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {isLoadingBoards ? (
                <ActivityIndicator color={REFERENCE_THEME.accent} style={styles.loading} />
              ) : collections.length > 0 ? collections.map((board: any) => {
                const active = effectiveSelected === board.board_id;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    key={board.board_id}
                    onPress={() => setSelected(board.board_id)}
                    style={({ pressed }) => [
                      styles.collection,
                      active ? styles.collectionSelected : styles.collectionIdle,
                      pressed && styles.rowPressed,
                    ]}
                  >
                    <Text style={styles.collectionName} numberOfLines={1}>{board.board_name}</Text>
                    <View style={[styles.radio, active ? styles.radioSelected : styles.radioIdle]} />
                  </Pressable>
                );
              }) : (
                <Text style={styles.empty}>Create a collection to save this repository.</Text>
              )}
            </ScrollView>

            {isCreating ? (
              <View style={styles.newCollectionRow}>
                <TextInput
                  autoFocus
                  editable={!createBoardMutation.isPending}
                  onChangeText={setNewCollection}
                  onSubmitEditing={createCollection}
                  placeholder="New collection name"
                  placeholderTextColor="rgba(235,235,245,0.30)"
                  returnKeyType="done"
                  style={styles.newCollectionInput}
                  value={newCollection}
                />
                <Pressable
                  accessibilityLabel="Create collection"
                  disabled={!newCollection.trim() || createBoardMutation.isPending}
                  onPress={createCollection}
                  style={({ pressed }) => [styles.newCollectionSubmit, pressed && styles.pressed]}
                >
                  {createBoardMutation.isPending ? (
                    <ActivityIndicator size="small" color={REFERENCE_THEME.text} />
                  ) : (
                    <Check size={16} color={REFERENCE_THEME.text} strokeWidth={2.4} />
                  )}
                </Pressable>
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => setIsCreating(true)}
                style={({ pressed }) => [styles.createButton, pressed && styles.pressed]}
              >
                <Text style={styles.createText}>+ Create new collection</Text>
              </Pressable>
            )}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saveDisabled }}
              disabled={saveDisabled}
              onPress={saveRepository}
              style={({ pressed }) => [
                styles.saveButton,
                saveDisabled && styles.saveButtonDisabled,
                pressed && !saveDisabled && styles.rowPressed,
              ]}
            >
              {addRepoToBoardMutation.isPending ? (
                <ActivityIndicator size="small" color={REFERENCE_THEME.text} />
              ) : (
                <Text style={[styles.saveText, saveDisabled && styles.saveTextDisabled]}>
                  {status === 'saved'
                    ? 'Saved'
                    : selectedBoard?.board_name
                      ? `Save to ${selectedBoard.board_name}`
                      : 'Save to collection'}
                </Text>
              )}
            </Pressable>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    zIndex: 100,
  },
  overlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  keyboardLayer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  sheet: {
    minHeight: 350,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: REFERENCE_THEME.surface,
    overflow: 'hidden',
  },
  grabberWrap: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 6,
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(235,235,245,0.20)',
  },
  content: {
    paddingTop: 4,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  headerCopy: {
    flex: 1,
    paddingRight: 12,
  },
  title: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.3,
  },
  subtitle: {
    marginTop: 3,
    color: 'rgba(235,235,245,0.55)',
    fontFamily: 'NataSans-Regular',
    fontSize: 12.5,
    lineHeight: 17,
  },
  closeButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(118,118,128,0.24)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  collectionList: {
    maxHeight: 220,
    marginTop: 16,
  },
  collectionListContent: {
    gap: 9,
  },
  loading: {
    marginVertical: 28,
  },
  collection: {
    height: 46,
    paddingHorizontal: 15,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: 'rgba(118,118,128,0.12)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  collectionIdle: {
    borderColor: 'rgba(255,255,255,0.14)',
  },
  collectionSelected: {
    borderColor: REFERENCE_THEME.accent,
    borderWidth: 1.5,
  },
  collectionName: {
    flex: 1,
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Medium',
    fontSize: 14,
    lineHeight: 19,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  radioIdle: {
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.30)',
  },
  radioSelected: {
    borderWidth: 5.5,
    borderColor: REFERENCE_THEME.accent,
  },
  empty: {
    marginVertical: 22,
    color: REFERENCE_THEME.textTertiary,
    fontFamily: 'NataSans-Regular',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  createButton: {
    width: '100%',
    height: 40,
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createText: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 13.5,
    lineHeight: 18,
  },
  newCollectionRow: {
    height: 46,
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  newCollectionInput: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: REFERENCE_THEME.accent,
    backgroundColor: 'rgba(118,118,128,0.12)',
    paddingHorizontal: 15,
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Regular',
    fontSize: 14,
  },
  newCollectionSubmit: {
    width: 46,
    height: 46,
    borderRadius: 12,
    backgroundColor: REFERENCE_THEME.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    marginTop: 4,
    color: REFERENCE_THEME.danger,
    fontFamily: 'NataSans-Regular',
    fontSize: 12,
    textAlign: 'center',
  },
  saveButton: {
    width: '100%',
    height: 48,
    marginTop: 10,
    borderRadius: 12,
    backgroundColor: REFERENCE_THEME.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonDisabled: {
    backgroundColor: REFERENCE_THEME.surfaceElevated,
  },
  saveText: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.2,
  },
  saveTextDisabled: {
    color: REFERENCE_THEME.textDisabled,
  },
  pressed: {
    opacity: 0.7,
  },
  rowPressed: {
    transform: [{ scale: 0.985 }],
  },
});
