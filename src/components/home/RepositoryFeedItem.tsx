import React, { useRef, useState } from 'react';
import {
  AppState,
  Platform,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';

import type { RepositoryData } from '../../data/repositories';
import type { ActivityInput } from '../../api/activity';
import {useQueryClient} from '@tanstack/react-query';
import {useAuth} from '@/store/AuthContext';
import {authSessionLifecycle} from '@/api/session-lifecycle';
import { usePrefetchRepositoryLists } from '@/hooks/use-repository-lists';
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
  SAVE_SWIPE_ACTIVATION_DISTANCE,
  SAVE_SWIPE_LEFT_FAIL_DISTANCE,
  SAVE_SWIPE_VERTICAL_FAIL_DISTANCE,
  shouldOpenSavePicker,
} from './save-swipe-gesture';
import { ShareRepositorySheet } from './share-repository-sheet';

const WEB_FEED_ITEM_STYLE =
  Platform.OS === 'web'
    ? ({ scrollSnapAlign: 'start', scrollSnapStop: 'always' } as ViewStyle)
    : null;

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
  const [summaryIdentity,setSummaryIdentity] = useState<{version:number | null;hash:string | null}>({version:null,hash:null});
  const [isCommentsVisible, setIsCommentsVisible] = useState(false);
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
  const {user}=useAuth();
  const queryClient=useQueryClient();
  const generation=authSessionLifecycle.currentGeneration();
  const ownerId=user?.user_id;
  const {id:repoId,serveId,feedPosition,feedSessionId}=repository;
  usePrefetchRepositoryLists(repoId, ownerId, isViewable && isAppActive);
  const attribution=React.useMemo(()=>({
    row:feedAttribution(ownerId,{id:repoId,serveId,feedPosition,feedSessionId} as RepositoryData),generation,
  }),[ownerId,repoId,serveId,feedPosition,feedSessionId,generation]);
  const overlaysOpen = isSaveVisible || isShareVisible || isReadmeVisible || isOriginalReadmeVisible || isCommentsVisible;
  const measurementActive = isViewable && isAppActive && !overlaysOpen;
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
  }, [isViewable]);

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

  const triggerSaveHaptic = React.useCallback(() => {
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

  const openSavePopup = React.useCallback(() => {
    setIsSaveVisible(true);
  }, []);

  const openSaveFromSwipe = React.useCallback(() => {
    triggerSaveHaptic();
    openSavePopup();
  }, [openSavePopup, triggerSaveHaptic]);

  const handleSavedChange = React.useCallback((saved: boolean, saveStateChanged: boolean) => {
    setSavedState({ repositoryId: repository.id, serverSaved, saved });
    onSavedChange?.(saved, saveStateChanged);
  }, [onSavedChange, repository.id, serverSaved]);

  const saveSwipeGesture = React.useMemo(() => Gesture.Pan()
    .enabled(!overlaysOpen)
    .activeOffsetX(SAVE_SWIPE_ACTIVATION_DISTANCE)
    .failOffsetX(-SAVE_SWIPE_LEFT_FAIL_DISTANCE)
    .failOffsetY([
      -SAVE_SWIPE_VERTICAL_FAIL_DISTANCE,
      SAVE_SWIPE_VERTICAL_FAIL_DISTANCE,
    ])
    .maxPointers(1)
    .onEnd((event, success) => {
      if (!success) return;
      if (shouldOpenSavePicker(event.translationX, event.translationY)) {
        scheduleOnRN(openSaveFromSwipe);
      }
    }), [overlaysOpen, openSaveFromSwipe]);

  const boundaryHeight = boundary ? 56 : 0;

  return (
    <View
      style={[styles.feedItem, { width: pageWidth, height: pageHeight }, WEB_FEED_ITEM_STYLE]}
    >
      <GestureDetector
        gesture={saveSwipeGesture}
        touchAction={Platform.OS === 'web' ? 'pan-y' : undefined}
      >
        <View style={styles.feedForeground}>
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
                setSummaryIdentity({version:digest?.content_version ?? repository.contentVersion,hash:digest?.content_hash ?? repository.contentHash ?? null});
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
        </View>
      </GestureDetector>

      {boundary}
      {isSaveVisible ? <SavePopup
        mutations={{ state: saveMutations, onChange: setSaveMutations }}
        isVisible={isSaveVisible}
        onClose={() => setIsSaveVisible(false)}
        onSaved={handleSavedChange}
        position={repository.feedPosition}
        repoId={repository.id}
        repoName={repository.name}
        repository={repository}
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
          summaryText={expandedSummary} summaryVersion={summaryIdentity.version} summaryHash={summaryIdentity.hash} />
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
});
