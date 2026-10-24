import React, { useRef, useState } from 'react';
import {
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Bookmark } from 'lucide-react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { RepositoryData } from '../../data/repositories';
import type { ActivityInput } from '../../api/activity';
import {useQueryClient} from '@tanstack/react-query';
import {useAuth} from '@/store/AuthContext';
import {authSessionLifecycle} from '@/api/session-lifecycle';
import {createUuid} from '@/utils/uuid';
import {type OriginalFeedImpression,feedAttribution,parseOriginalFeedImpression,rememberOriginalFeedImpression,rememberFeedNavigation} from '@/services/feedImpressionAttribution';
import { reconcileFeedItemSavedState } from '@/utils/feed-repository';
import {
  DWELL_VISIBILITY_THRESHOLD_MS,
  FEEDBACK_ACTIONS,
  IMPRESSION_VISIBILITY_THRESHOLD_MS,
} from '../../constants/feedbackActions';
import { CommentSheet, type CommentComposerState } from './CommentSheet';
import { SaveSwipeGestureContext } from './DescriptionCard';
import { FeedReadmePopup } from './FeedReadmePopup';
import { prepareReadmeSummaryDocument } from '@/utils/readme';
import { RepositoryScreen } from './RepositoryScreen';
import { SavePopup, type SavePopupMutationState } from './save-popup';
import {
  SAVE_REVEAL_WIDTH,
  SAVE_SWIPE_ACTIVATION_DISTANCE,
  SAVE_SWIPE_LEFT_FAIL_DISTANCE,
  SAVE_SWIPE_VERTICAL_FAIL_DISTANCE,
  getSaveRevealTranslation,
  shouldRevealSaveAction,
} from './save-swipe-gesture';
import { ShareRepositorySheet } from './share-repository-sheet';

const WEB_FEED_ITEM_STYLE =
  Platform.OS === 'web'
    ? ({ scrollSnapAlign: 'start', scrollSnapStop: 'always' } as ViewStyle)
    : null;

const SAVE_REVEAL_SPRING = {
  damping: 24,
  mass: 0.72,
  overshootClamping: true,
  stiffness: 280,
};

export function RepositoryFeedItem({
  repository,
  pageWidth,
  pageHeight,
  isViewable = false,
  boundary,
  onOwnerPress,
  onRepositoryPress,
  onQueueActivity,
  onSavedChange,
}: {
  repository: RepositoryData;
  pageWidth: number;
  pageHeight: number;
  isViewable?: boolean;
  boundary?: React.ReactNode;
  onOwnerPress?: () => void;
  onRepositoryPress?: (navigationToken?:string) => void;
  onSavedChange?: (saved: boolean, saveStateChanged: boolean) => void;
  onQueueActivity?: (event:ActivityInput,flushNow?:boolean)=>void;
}) {
  const [isSaveVisible, setIsSaveVisible] = useState(false);
  const [saveMutations, setSaveMutations] = useState<SavePopupMutationState>({ save: false, create: false, error: null });
  const [isShareVisible, setIsShareVisible] = useState(false);
  const [isReadmeVisible, setIsReadmeVisible] = useState(false);
  const [isOriginalReadmeVisible, setIsOriginalReadmeVisible] = useState(false);
  const [expandedSummary, setExpandedSummary] = useState<string | null>(null);
  const [isCommentsVisible, setIsCommentsVisible] = useState(false);
  const [isSaveRevealOpen, setIsSaveRevealOpen] = useState(false);
  // Keep only lightweight composer state while the expensive sheet is unmounted.
  const [commentComposer, setCommentComposer] = useState<CommentComposerState>({ draft: '', error: null, pending: false });
  const [isAppActive, setIsAppActive] = useState(
    AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
  );
  const serverSaved = repository.viewerSaved === true;
  const [savedState, setSavedState] = useState(() => ({
    repositoryId: repository.id,
    serverSaved,
    saved: serverSaved,
  }));
  const reconciledSavedState = reconcileFeedItemSavedState(
    savedState,
    repository.id,
    serverSaved,
  );
  if (reconciledSavedState !== savedState) {
    setSavedState(reconciledSavedState);
  }
  const isSaved = reconciledSavedState.saved;
  const [commentCount, setCommentCount] = useState(
    Number(repository.stats.comments || 0) || 0
  );

  const visibleStartTime = useRef<number | null>(null);
  const impressionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const impressionSentRef = useRef(false);
  const saveRevealTranslateX = useSharedValue(0);
  const saveRevealHapticSent = useSharedValue(false);
  const overlaysOpen = isSaveVisible || isShareVisible || isReadmeVisible || isOriginalReadmeVisible || isCommentsVisible;
  const measurementActive = isViewable && isAppActive && !overlaysOpen;
  const {user}=useAuth();
  const queryClient=useQueryClient();
  const generation=authSessionLifecycle.currentGeneration();
  const ownerId=user?.user_id;
  const {id:repoId,serveId,feedPosition,feedSessionId}=repository;
  const attribution=React.useMemo(()=>({
    row:feedAttribution(ownerId,{id:repoId,serveId,feedPosition,feedSessionId} as RepositoryData),generation,
  }),[ownerId,repoId,serveId,feedPosition,feedSessionId,generation]);
  const attributionState=useRef(new WeakMap<object,{original:OriginalFeedImpression|null;deliver:typeof onQueueActivity}>());
  // A row keeps its clock across optimistic callbacks; an old cleanup retains
  // its own owner/row lease and callback rather than reading a replacement row.
  React.useLayoutEffect(()=>{
    const state=attributionState.current.get(attribution)??{original:null,deliver:onQueueActivity};
    state.deliver=onQueueActivity;
    attributionState.current.set(attribution,state);
  },[attribution,onQueueActivity]);
  React.useLayoutEffect(()=>{
    const state=attributionState.current.get(attribution)!;
    const cached=parseOriginalFeedImpression(repository.originalImpression);
    state.original??=cached;
    if(attribution.row&&state.original&&authSessionLifecycle.isCurrent(attribution.generation)
      &&(cached?.eventId!==state.original.eventId||cached.occurredAt!==state.original.occurredAt)) {
      state.original=rememberOriginalFeedImpression(queryClient,attribution.row,state.original);
    }
  },[attribution,queryClient,repository.originalImpression]);
  const queueRepositoryActivity=React.useCallback((event:ActivityInput,flushNow?:boolean)=>{
    const state=attributionState.current.get(attribution);
    if(!state?.deliver||!authSessionLifecycle.isCurrent(attribution.generation))return;
    const observed=event.action===FEEDBACK_ACTIONS.impression
      ?{eventId:createUuid(),occurredAt:new Date().toISOString()}:null;
    if(observed&&attribution.row&&!state.original) {
      state.original=rememberOriginalFeedImpression(queryClient,attribution.row,observed);
    }
    state.deliver({
      ...event,serve_id:repository.serveId??null,position:repository.feedPosition??null,
      ...(attribution.row?{session_id:attribution.row.sessionId}:{}),
      ...(observed?{event_id:observed.eventId,client_occurred_at:observed.occurredAt}:{}),
      ...(!observed&&attribution.row&&state.original?{impression_event_id:state.original.eventId}:{}),
    },flushNow);
  },[attribution,queryClient,repository.serveId,repository.feedPosition]);
  const openRepository=React.useCallback(()=>{
    if(!onRepositoryPress||!authSessionLifecycle.isCurrent(attribution.generation))return;
    const token=attribution.row?rememberFeedNavigation(queryClient,{...attribution.row,generation:attribution.generation,original:attributionState.current.get(attribution)?.original??null}):undefined;
    onRepositoryPress(token);
  },[attribution,onRepositoryPress,queryClient]);

  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setIsAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  React.useEffect(() => {
    if (isViewable) return;
    impressionSentRef.current = false;
    saveRevealTranslateX.set(0);
    const resetRevealState = setTimeout(() => setIsSaveRevealOpen(false), 0);
    return () => clearTimeout(resetRevealState);
  }, [isViewable, saveRevealTranslateX]);

  React.useEffect(() => {
    const finishVisibility = () => {
      if (visibleStartTime.current === null) return;
      const dwellSeconds = (Date.now() - visibleStartTime.current) / 1000;
      if (impressionTimeoutRef.current) {
        clearTimeout(impressionTimeoutRef.current);
        impressionTimeoutRef.current = null;
      }
      if (dwellSeconds * 1000 >= DWELL_VISIBILITY_THRESHOLD_MS) {
        queueRepositoryActivity({
          repo_id: repository.id,
          action: FEEDBACK_ACTIONS.dwell,
          dwell_seconds: dwellSeconds,
        });
      }
      visibleStartTime.current = null;
    };

    if (measurementActive) {
      visibleStartTime.current = Date.now();
      if (impressionTimeoutRef.current) clearTimeout(impressionTimeoutRef.current);
      impressionTimeoutRef.current = setTimeout(() => {
        if (visibleStartTime.current !== null && !impressionSentRef.current) {
          impressionSentRef.current = true;
          queueRepositoryActivity({ repo_id: repository.id, action: FEEDBACK_ACTIONS.impression });
        }
      }, IMPRESSION_VISIBILITY_THRESHOLD_MS);
    } else finishVisibility();

    return finishVisibility;
  }, [measurementActive, queueRepositoryActivity, repository.id]);

  const updateSaveRevealState = React.useCallback((open: boolean) => {
    setIsSaveRevealOpen(open);
  }, []);

  const triggerSaveRevealHaptic = React.useCallback(() => {
    if (Platform.OS === 'android') {
      void Haptics.performAndroidHapticsAsync(
        Haptics.AndroidHaptics.Segment_Tick,
      ).catch(() => undefined);
      return;
    }
    if (Platform.OS === 'ios') {
      void Haptics.selectionAsync().catch(() => undefined);
    }
  }, []);

  const closeSaveReveal = React.useCallback(() => {
    setIsSaveRevealOpen(false);
    saveRevealTranslateX.set(withSpring(0, SAVE_REVEAL_SPRING));
  }, [saveRevealTranslateX]);

  const openSavePopup = React.useCallback(() => {
    closeSaveReveal();
    setIsSaveVisible(true);
  }, [closeSaveReveal]);

  const handleSavedChange = React.useCallback((saved: boolean, saveStateChanged: boolean) => {
    setSavedState({ repositoryId: repository.id, serverSaved, saved });
    onSavedChange?.(saved, saveStateChanged);
  }, [onSavedChange, repository.id, serverSaved]);

  const saveSwipeGesture = React.useMemo(() => Gesture.Pan()
    .enabled(Platform.OS !== 'web' && !overlaysOpen && !isSaveRevealOpen)
    .activeOffsetX(SAVE_SWIPE_ACTIVATION_DISTANCE)
    .failOffsetX(-SAVE_SWIPE_LEFT_FAIL_DISTANCE)
    .failOffsetY([
      -SAVE_SWIPE_VERTICAL_FAIL_DISTANCE,
      SAVE_SWIPE_VERTICAL_FAIL_DISTANCE,
    ])
    .maxPointers(1)
    .onStart(() => {
      saveRevealHapticSent.set(false);
    })
    .onUpdate((event) => {
      saveRevealTranslateX.set(getSaveRevealTranslation(event.translationX));
      if (
        !saveRevealHapticSent.get()
        && shouldRevealSaveAction(event.translationX, event.translationY)
      ) {
        saveRevealHapticSent.set(true);
        scheduleOnRN(triggerSaveRevealHaptic);
      }
    })
    .onEnd((event) => {
      const shouldReveal = shouldRevealSaveAction(
        event.translationX,
        event.translationY,
      );
      saveRevealTranslateX.set(withSpring(
        shouldReveal ? SAVE_REVEAL_WIDTH : 0,
        SAVE_REVEAL_SPRING,
      ));
      scheduleOnRN(updateSaveRevealState, shouldReveal);
    })
    .onFinalize((_event, success) => {
      if (success) return;
      saveRevealTranslateX.set(withSpring(0, SAVE_REVEAL_SPRING));
      scheduleOnRN(updateSaveRevealState, false);
    }), [
    isSaveRevealOpen,
    overlaysOpen,
    saveRevealHapticSent,
    saveRevealTranslateX,
    triggerSaveRevealHaptic,
    updateSaveRevealState,
  ]);

  const boundaryHeight = boundary ? 56 : 0;
  const saveRevealAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: saveRevealTranslateX.get() }],
  }));

  return (
    <View
      style={[styles.feedItem, { width: pageWidth, height: pageHeight }, WEB_FEED_ITEM_STYLE]}
    >
      <View
        accessibilityElementsHidden={!isSaveRevealOpen}
        importantForAccessibility={isSaveRevealOpen ? 'yes' : 'no-hide-descendants'}
        pointerEvents={isSaveRevealOpen ? 'auto' : 'none'}
        style={[styles.saveReveal, { width: SAVE_REVEAL_WIDTH, bottom: boundaryHeight }]}
      >
        <Pressable
          accessibilityHint="Opens the Save dialog to choose a list"
          accessibilityLabel="Save repository"
          accessibilityRole="button"
          onPress={openSavePopup}
          style={({ pressed }) => [
            styles.saveRevealAction,
            pressed && styles.saveRevealActionPressed,
          ]}
        >
          <Bookmark
            color="#86F9AA"
            fill={isSaved ? '#86F9AA' : 'none'}
            size={27}
            strokeWidth={2.2}
          />
          <Text style={styles.saveRevealLabel}>Save</Text>
        </Pressable>
      </View>

      <GestureDetector
        gesture={saveSwipeGesture}
        touchAction={Platform.OS === 'web' ? 'auto' : undefined}
      >
        <Animated.View
          accessibilityElementsHidden={isSaveRevealOpen}
          importantForAccessibility={isSaveRevealOpen ? 'no-hide-descendants' : 'auto'}
          style={[styles.feedForeground, saveRevealAnimatedStyle]}
        >
          <SaveSwipeGestureContext.Provider value={saveSwipeGesture}>
            <RepositoryScreen
              commentCount={commentCount}
              isActive={isViewable}
              isSaved={isSaved}
              onCommentPress={() => setIsCommentsVisible(true)}
              onOwnerPress={onOwnerPress}
              onRepositoryPress={openRepository}
              onQueueActivity={queueRepositoryActivity}
              onOpenReadme={() => {
                queueRepositoryActivity({ repo_id: repository.id, action: FEEDBACK_ACTIONS.readmeOpen }, true);
                setIsOriginalReadmeVisible(true);
              }}
              onReadFullPress={(digest) => {
                setExpandedSummary(prepareReadmeSummaryDocument({ ...repository, readmeDigest: digest }));
                queueRepositoryActivity(
                  { repo_id: repository.id, action: FEEDBACK_ACTIONS.readmeOpen },
                  true
                );
                setIsReadmeVisible(true);
              }}
              onSavePress={openSavePopup}
              onSharePress={() => setIsShareVisible(true)}
              pageHeight={Math.max(1, pageHeight - boundaryHeight)}
              pageWidth={pageWidth}
              repository={repository}
            />
          </SaveSwipeGestureContext.Provider>
        </Animated.View>
      </GestureDetector>

      {isSaveRevealOpen ? (
        <Pressable
          accessibilityHint="Returns to the repository card"
          accessibilityLabel="Close Save actions"
          accessibilityRole="button"
          onPress={closeSaveReveal}
          style={styles.saveRevealDismiss}
        />
      ) : null}

      {boundary}
      {isSaveVisible ? <SavePopup
        mutations={{ state: saveMutations, onChange: setSaveMutations }}
        isVisible={isSaveVisible}
        onClose={() => setIsSaveVisible(false)}
        onSaved={handleSavedChange}
        position={repository.feedPosition}
        repoId={repository.id}
        repoName={repository.name}
        serveId={repository.serveId}
        sessionId={attribution.row?.sessionId}
        impressionEventId={attribution.row?repository.originalImpression?.eventId:undefined}
      /> : null}
      {isShareVisible ? <ShareRepositorySheet
        isVisible={isShareVisible}
        onClose={() => setIsShareVisible(false)}
        onShared={() => queueRepositoryActivity(
          { repo_id: repository.id, action: FEEDBACK_ACTIONS.share },
          true,
        )}
        onGithubOpened={() => queueRepositoryActivity(
          { repo_id: repository.id, action: FEEDBACK_ACTIONS.githubOpen },
          true,
        )}
        repositoryId={repository.id}
        repositoryDetails={{
          id: repository.id,
          fullName: repository.fullName,
          githubUrl: repository.githubUrl,
          description: repository.description,
        }}
      /> : null}
      {isCommentsVisible ? <CommentSheet
        composer={{ state: commentComposer, onChange: setCommentComposer }}
        initialCommentCount={commentCount}
        isVisible={isCommentsVisible}
        onClose={() => setIsCommentsVisible(false)}
        onCommentCountChange={setCommentCount}
        repoId={repository.id}
      /> : null}
      {isOriginalReadmeVisible ? <FeedReadmePopup repository={repository} onClose={() => setIsOriginalReadmeVisible(false)} /> : null}
      {isReadmeVisible ? (
        <FeedReadmePopup repository={repository} onClose={() => setIsReadmeVisible(false)}
          summaryText={expandedSummary} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  feedItem: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
  feedForeground: {
    flex: 1,
    backgroundColor: '#000000',
  },
  saveReveal: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#123520',
    borderRightColor: 'rgba(134,249,170,0.22)',
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  saveRevealAction: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  saveRevealActionPressed: {
    backgroundColor: 'rgba(134,249,170,0.12)',
  },
  saveRevealLabel: {
    color: '#E8FFEF',
    fontFamily: 'NataSans-SemiBold',
    fontSize: 13,
    lineHeight: 18,
  },
  saveRevealDismiss: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: SAVE_REVEAL_WIDTH,
  },
});
