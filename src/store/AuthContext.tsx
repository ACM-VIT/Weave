import { accessTokenOwner } from '../api/access-token-owner';
import {retireFeedBeforeLogout} from '../services/feedSessionLogout';
import { feedSessions } from '../api/feed-sessions';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getStorageItem } from '../utils/storage';
import { logout as logoutRequest } from '../api/auth';
import { apiV2, refreshSession, setSessionExpiredHandler } from '../api/client';
import { httpStatus } from '../api/session-errors';
import { setupOnboarding, type OnboardingData } from '../api/onboarding';
import { authSessionLifecycle, SessionChangedError } from '../api/session-lifecycle';
import {
  isSessionRestoreBlocked,
  LogoutNotCompletedError,
  retireSessionIfCurrent,
  type AuthenticatedSession,
} from '../api/session-transitions';
import { resolveOnboardingCompleted } from '../utils/auth-routing';
import {
  mergeSavedUserProfile,
  mergeSavedAvatar,
  preserveNewerAvatar,
  type SavedUserProfileAttributes,
} from '../utils/profile-state';
import { restoreStartupSession, StartupSessionTimeoutError, withStartupSessionDeadline } from './restore-session';
import { useQueryClient } from '@tanstack/react-query';
import { clearAccountQueryCache } from '../services/accountQueryCache';

interface User {
  user_id: string;
  username: string;
  email?: string;
  onboarding_completed: boolean;
  [key: string]: any;
}

export type EditableUserProfile = SavedUserProfileAttributes;

export const ONBOARDING_SAVE_TIMEOUT_MS = 15_000;
const UNKNOWN_ONBOARDING_MESSAGE = 'Your preferences may have saved, but confirmation is still pending. Check save status before trying again.';

export class OnboardingOutcomeUnknownError extends Error {
  constructor() { super(UNKNOWN_ONBOARDING_MESSAGE); this.name = 'OnboardingOutcomeUnknownError'; }
}

type OnboardingSaveState = { status: 'idle' | 'saving' | 'unknown' | 'checking' | 'retryable'; message: string | null };
type OnboardingFlight = {
  generation: number; owner: string; stage: 'preparing' | 'writing' | 'refreshing';
  cancelled: boolean; deadlineExpired: boolean; settled: boolean; reconciled: boolean; promise: Promise<void>;
  profileController?: AbortController;
  data: OnboardingData; expectedVersion?: string; casProtected: boolean; retryable: boolean;
};

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  startupError: string | null;
  retryStartupSession: () => Promise<void>;
  setSession: (session: AuthenticatedSession<any>) => Promise<void>;
  signOut: () => Promise<void>;
  checkOnboardingStatus: (lease?: {owner:string;generation:number}) => Promise<void>;
  completeOnboarding: (data: OnboardingData) => Promise<void>;
  finishOnboarding: (data: OnboardingData) => Promise<void>;
  reconcileOnboarding: () => Promise<void>;
  retryOnboarding: () => Promise<void>;
  onboardingSave: OnboardingSaveState;
  updateUserProfile: (profile: EditableUserProfile) => void;
  applySavedAvatar: (owner:string,generation:number,saved:{avatar_url:string;profile_version:string}) => void;
  adjustLikesGivenCount: (eventId: string, delta: -1 | 1) => void;
  settleLikesGivenCountAdjustments: (eventIds: readonly string[]) => void;
}

type UserProfileRequestPolicy = {
  owner?: string;
  confirmOnboarding?: boolean;
  allowRefresh?: boolean;
  clearUnauthorized?: boolean;
  logErrors?: boolean;
  sessionGeneration?: number;
  signal?: AbortSignal;
};

function onboardingProfileVersion(value: unknown): string | undefined {
  const version = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  return /^(0|[1-9][0-9]{0,18})$/.test(version) && BigInt(version) <= 9223372036854775807n ? version : undefined;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const startupController = useRef<AbortController | null>(null);
  const profileGeneration = useRef<number | null>(null);
  const userGeneration = profileGeneration.current;
  const [onboardingSave, setOnboardingSave] = useState<OnboardingSaveState>({ status: 'idle', message: null });
  const onboardingFlight = useRef<OnboardingFlight | null>(null);
  const onboardingCheck = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const resetOnboardingSave = useCallback(() => {
    if (onboardingFlight.current?.stage === 'preparing') onboardingFlight.current.cancelled = true;
    onboardingFlight.current?.profileController?.abort();
    onboardingFlight.current = null;
    onboardingCheck.current?.controller.abort();
    onboardingCheck.current = null;
    setOnboardingSave({ status: 'idle', message: null });
  }, []);
  const pendingLikesGivenEvents = useRef(new Map<string, -1 | 1>());
  const likesGivenRevision = useRef(0);
  const profileReadSequence = useRef(0);
  const appliedCountReadSequence = useRef(0);
  const onboardingConfirmation = useRef(0);
  const profileTransitionTail = useRef<{ generation: number; tail: Promise<unknown> }>({ generation: authSessionLifecycle.currentGeneration(), tail: Promise.resolve() });
  const serializeProfileTransition = useCallback(<T,>(generation: number, operation: () => Promise<T>) => {
    if (profileTransitionTail.current.generation !== generation) {
      profileTransitionTail.current = { generation, tail: Promise.resolve() };
    }
    const running = profileTransitionTail.current.tail.catch(() => undefined).then(() => {
      authSessionLifecycle.assertCurrent(generation);
      return operation();
    });
    profileTransitionTail.current.tail = running;
    return running;
  }, []);


  const fetchUserProfile = useCallback(async (
    token: string,
    {
      allowRefresh = true,
      clearUnauthorized = true,
      logErrors = true,
      sessionGeneration = authSessionLifecycle.currentGeneration(),
      signal,
      owner,
      confirmOnboarding = false,
    }: UserProfileRequestPolicy = {},
  ) => {
    const readSequence = ++profileReadSequence.current;
    const likesRevisionAtStart = likesGivenRevision.current;
    const onboardingAtStart = onboardingConfirmation.current;
    const assertCurrent = () => {
      authSessionLifecycle.assertCurrent(sessionGeneration);
      if (signal?.aborted) throw new SessionChangedError();
    };
    try {
      assertCurrent();
      const requestPolicy = { allowRefresh };
      const profile = await apiV2<Record<string, unknown>>('/users/me', { signal }, token, requestPolicy);
      assertCurrent();
      if (owner && profile.user_id !== owner) throw new SessionChangedError();
      const completionStatus = typeof profile.onboarding_completed === 'boolean'
        ? profile.onboarding_completed
        : (await apiV2<{ completed: boolean }>('/onboarding/status', { signal }, token, requestPolicy)).completed;
      assertCurrent();
      if (onboardingAtStart !== onboardingConfirmation.current) return;
      const serverLikesGivenCount = Number(profile.likes_given_count);
      // Failed or still-pending requests cannot supersede a successful count.
      if (pendingLikesGivenEvents.current.size === 0
        && likesRevisionAtStart === likesGivenRevision.current) {
        appliedCountReadSequence.current = Math.max(appliedCountReadSequence.current, readSequence);
      }
      // A successful owner-bound reconciliation is a confirmation too. Fence
      // reads that began before it, without invalidating its own queued update.
      const appliedOnboarding = confirmOnboarding && resolveOnboardingCompleted(profile, completionStatus)
        ? ++onboardingConfirmation.current : onboardingAtStart;
      profileGeneration.current = sessionGeneration;
      setUser(current => {
        if (!authSessionLifecycle.isCurrent(sessionGeneration) || appliedOnboarding !== onboardingConfirmation.current
          || (owner && current?.user_id !== owner)) return current;
        return preserveNewerAvatar(current, {
        ...profile,
        user_id: String(profile.user_id),
        username: String(profile.username),
        onboarding_completed: resolveOnboardingCompleted(profile, completionStatus),
        // Aggregate counts cannot tell us which queued events have committed.
        // Keep the optimistic display until the queue settles, then accept a
        // fresh authoritative count. Older reads cannot undo newer reactions.
        likes_given_count: current && (
          pendingLikesGivenEvents.current.size > 0
          || likesRevisionAtStart !== likesGivenRevision.current
          || readSequence < appliedCountReadSequence.current
        ) ? current.likes_given_count
          : Math.max(0, Number.isFinite(serverLikesGivenCount) ? serverLikesGivenCount : 0),
      });
      });
      return { ...profile, user_id: String(profile.user_id), onboarding_completed: resolveOnboardingCompleted(profile, completionStatus) } as Record<string, unknown> & { user_id: string; onboarding_completed: boolean };
    } catch (error) {
      assertCurrent();
      if (onboardingAtStart !== onboardingConfirmation.current) return;
      const status = httpStatus(error);
      const responseToken = typeof (error as { accessToken?: unknown })?.accessToken === 'string'
        ? (error as { accessToken: string }).accessToken
        : token;
      // A 404 means an older valid session predates its v2 product profile.
      // Clear it so the next login can run ensureIdentityProfile atomically.
      if (status === 404 || (status === 401 && clearUnauthorized)) {
        await serializeProfileTransition(sessionGeneration, async () => {
          assertCurrent();
          if (onboardingAtStart !== onboardingConfirmation.current) return;
          const retired = await retireSessionIfCurrent(sessionGeneration, responseToken, assertCurrent);
          if (retired) setUser(null);
        });
        if (onboardingAtStart !== onboardingConfirmation.current) return;
      }
      if (logErrors && !(error instanceof SessionChangedError)) {
        console.error('Failed to fetch user profile', error);
      }
      throw error;
    }
  }, [serializeProfileTransition]);

  const loadSession = useCallback(async () => {
    const sessionGeneration = authSessionLifecycle.currentGeneration();
    startupController.current?.abort();
    const controller = new AbortController();
    startupController.current = controller;
    // Keep the recovery view visible while a retry is pending. Only a current
    // completed restore (or a superseding auth transition) can clear its error.
    setIsLoading(true);
    try {
      await withStartupSessionDeadline(controller, async (signal) => {
        const assertCurrent = () => {
          authSessionLifecycle.assertCurrent(sessionGeneration);
          if (signal.aborted) throw new SessionChangedError();
        };
        const restoreBlocked = await isSessionRestoreBlocked();
        assertCurrent();
        if (restoreBlocked) {
          // A previous logout or interrupted auth transition deliberately left a
          // durable marker. Stay anonymous and retry server-side cookie cleanup;
          // a later successful login is serialized after this request and wins.
          setIsLoading(false);
          void logoutRequest().catch((error) => {
            console.error('Failed to retry server session revocation', error);
          });
          return;
        }

        await restoreStartupSession({
          getAccessToken: () => getStorageItem('access_token'),
          // A UI timeout must not discard a one-use refresh rotation response.
          // The shared refresh keeps its session lease; retry joins that flight.
          refreshAccessToken: (expectedToken) => refreshSession(expectedToken),
          assertSessionCurrent: assertCurrent,
          // Startup recovery owns one bounded refresh cycle and reuses a token
          // already rotated by another request before attempting another refresh.
          loadUserProfile: async (token, attempt) => { await fetchUserProfile(token, {
            allowRefresh: false,
            clearUnauthorized: attempt !== 'stored',
            logErrors: false,
            sessionGeneration,
            signal,
          }); },
        });
      });
      if (!controller.signal.aborted
        && startupController.current === controller
        && authSessionLifecycle.isCurrent(sessionGeneration)) setStartupError(null);
    } catch (e) {
      if (startupController.current !== controller || !authSessionLifecycle.isCurrent(sessionGeneration)) return;
      if (e instanceof StartupSessionTimeoutError) {
        // The deadline already invalidated this attempt's profile/UI work. Keep
        // the session generation so its pending cookie rotation can still finish.
        setStartupError(e.message);
        setIsLoading(false);
      } else if (!(e instanceof SessionChangedError)) {
        console.error('Failed to load session', e);
        setStartupError('Could not restore your session. Check your connection and try again.');
      }
    } finally {
      if (startupController.current === controller) {
        startupController.current = null;
        if (!controller.signal.aborted && authSessionLifecycle.isCurrent(sessionGeneration)) setIsLoading(false);
      }
    }
  }, [fetchUserProfile]);

  const checkOnboardingStatus = useCallback(async (lease?: {owner:string;generation:number}) => {
    const sessionGeneration = lease?.generation ?? authSessionLifecycle.currentGeneration();
    authSessionLifecycle.assertCurrent(sessionGeneration);
    const token = await getStorageItem('access_token');
    authSessionLifecycle.assertCurrent(sessionGeneration);
    if (lease && (!token || accessTokenOwner(token) !== lease.owner)) throw new SessionChangedError();
    if (token) {
      const profile = await fetchUserProfile(token, { sessionGeneration, owner: lease?.owner });
      authSessionLifecycle.assertCurrent(sessionGeneration);
      if (lease && profile?.user_id !== lease.owner) throw new SessionChangedError();
    }
  }, [fetchUserProfile]);

  const completeOnboarding = useCallback(async (data: OnboardingData, replay?: OnboardingFlight) => {
    // The profile's render-bound lease also fences retained pre-logout forms.
    const sessionGeneration = userGeneration;
    const owner = user?.user_id;
    if (sessionGeneration === null) throw new SessionChangedError();
    authSessionLifecycle.assertCurrent(sessionGeneration);
    if (!owner) throw new Error('No authenticated profile found. Please sign in again.');
    if (replay) {
      if (replay !== onboardingFlight.current || !replay.retryable || !replay.settled || !replay.casProtected
        || replay.owner !== owner || replay.generation !== sessionGeneration) throw new OnboardingOutcomeUnknownError();
    } else if (onboardingFlight.current) throw new OnboardingOutcomeUnknownError();
    const snapshot = replay?.data ?? { ...data, interests: data.interests?.slice(), skills: data.skills?.slice(), tech_stack: data.tech_stack?.slice() };
    const expectedVersion = replay ? replay.expectedVersion : (user?.onboarding_conditional_save === true ? onboardingProfileVersion(user.profile_version) : undefined);
    const flight: OnboardingFlight = { generation: sessionGeneration, owner, stage: 'preparing',
      data: snapshot, expectedVersion, casProtected: expectedVersion !== undefined, retryable: false,
      cancelled: false, deadlineExpired: false, settled: false, reconciled: false, promise: Promise.resolve() };
    onboardingFlight.current = flight;
    setOnboardingSave({ status: 'saving', message: null });
    const isCurrent = () => onboardingFlight.current === flight && authSessionLifecycle.isCurrent(sessionGeneration);
    let cancelPreparation!: (error: Error) => void;
    const preparationCancelled = new Promise<never>((_resolve, reject) => { cancelPreparation = reject; });
    // A deadline may expire before token acquisition reaches the lane.
    void preparationCancelled.catch(() => undefined);
    flight.promise = (async () => {
      try {
        const token = await getStorageItem('access_token');
        authSessionLifecycle.assertCurrent(sessionGeneration);
        if (flight.cancelled) throw new Error('Session lookup timed out. Try again.');
        if (!token) throw new Error('No authenticated profile found. Please sign in again.');
        const result = await serializeProfileTransition(sessionGeneration, () => Promise.race([(async () => {
          const likesAtStart = likesGivenRevision.current;
          if (flight.cancelled) throw new Error('Session lookup timed out. Try again.');
          const saved = await setupOnboarding(token, flight.data, { expectedVersion: flight.expectedVersion,
            allowLegacyFallback: !replay, onLegacyFallback: () => { flight.casProtected = false; }, beforeSend: () => {
            authSessionLifecycle.assertCurrent(sessionGeneration);
            if (flight.cancelled || flight.deadlineExpired) {
              throw Object.assign(new Error('Session lookup timed out before sending. Try Finish again.'), { code: 'ONBOARDING_PRE_SEND_TIMEOUT' });
            }
            flight.stage = 'writing';
          } });
          authSessionLifecycle.assertCurrent(sessionGeneration);
          if (saved.user_id !== undefined && saved.user_id !== owner) throw new SessionChangedError();
          const confirmed = saved.completed === true && saved.onboarding_completed === true
            && saved.user_id === owner && typeof saved.username === 'string';
          if (confirmed && !flight.reconciled) {
            // Retire older profile reads and failures while still holding the
            // same transition lane as the atomic completion request.
            onboardingConfirmation.current += 1;
            const sequence = ++profileReadSequence.current;
            const preserveLikes = pendingLikesGivenEvents.current.size > 0 || likesAtStart !== likesGivenRevision.current;
            if (!preserveLikes) appliedCountReadSequence.current = Math.max(appliedCountReadSequence.current, sequence);
            const likes = Number(saved.likes_given_count);
            profileGeneration.current = sessionGeneration;
            setUser(current => !flight.reconciled && authSessionLifecycle.isCurrent(sessionGeneration) && current?.user_id === owner
              ? preserveNewerAvatar(current, { ...current, ...saved, user_id: owner, username: saved.username!, onboarding_completed: true,
                likes_given_count: preserveLikes || saved.likes_given_count === undefined ? current.likes_given_count
                  : Math.max(0, Number.isFinite(likes) ? likes : 0) })
              : current);
          }
          return { token, confirmed };
        })(), preparationCancelled]));
        if (!result.confirmed && !flight.reconciled) {
          // An incomplete response still requires a durable read. Leave the
          // transition lane first so an invalid-profile read cannot deadlock
          // trying to retire its own session through that lane.
          flight.stage = 'refreshing';
          flight.profileController = new AbortController();
          await fetchUserProfile(result.token, { owner, confirmOnboarding: true, sessionGeneration, signal: flight.profileController.signal });
        }
        if (isCurrent()) {
          onboardingCheck.current?.controller.abort();
          onboardingFlight.current = null;
          setOnboardingSave({ status: 'idle', message: null });
        }
      } catch (error) {
        if (isCurrent()) {
          const status = httpStatus(error);
          const beforeSendExpired = (error as { code?: string })?.code === 'ONBOARDING_PRE_SEND_TIMEOUT';
          const definitelyRejected = beforeSendExpired || flight.stage === 'preparing'
            || (flight.stage === 'writing' && [400, 401, 403, 404, 409, 413, 422].includes(status ?? 0));
          if ((!replay && definitelyRejected) || flight.reconciled) {
            onboardingFlight.current = null;
            setOnboardingSave({ status: 'idle', message: beforeSendExpired && error instanceof Error ? error.message : null });
            if (flight.reconciled) return;
          } else {
            setOnboardingSave({ status: 'unknown', message: UNKNOWN_ONBOARDING_MESSAGE });
            throw new OnboardingOutcomeUnknownError();
          }
        }
        throw error;
      } finally { flight.settled = true; }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([flight.promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (!isCurrent()) { reject(new SessionChangedError()); return; }
          flight.deadlineExpired = true;
          if (flight.stage === 'preparing') {
            // A hung token read has not issued a PUT. Retire its continuation,
            // so a later token cannot silently submit after the visible timeout.
            flight.cancelled = true;
            // apiV2 also awaits storage during transport preparation. Release
            // only this unsent lane; beforeSend permanently fences its late
            // continuation. Once writing starts, no timeout releases the lane.
            cancelPreparation(new Error('Session lookup timed out. Try again.'));
            if (replay) {
              // This retry never sent, but its predecessor may still commit.
              // Restore that settled CAS authority without holding a lane on
              // this cancelled storage continuation.
              replay.retryable = false;
              onboardingFlight.current = replay;
              setOnboardingSave({ status: 'unknown', message: UNKNOWN_ONBOARDING_MESSAGE });
              reject(new OnboardingOutcomeUnknownError());
            } else {
              onboardingFlight.current = null;
              setOnboardingSave({ status: 'idle', message: null });
              reject(new Error('Session lookup timed out. Try again.'));
            }
          } else {
            // Do not abort/repeat a mutation that may already have committed.
            setOnboardingSave({ status: 'unknown', message: UNKNOWN_ONBOARDING_MESSAGE });
            reject(new OnboardingOutcomeUnknownError());
          }
        }, ONBOARDING_SAVE_TIMEOUT_MS);
      })]);
    } finally { clearTimeout(timer); }
  }, [fetchUserProfile, serializeProfileTransition, user, userGeneration]);

  const reconcileOnboarding = useCallback(async () => {
    const sessionGeneration = userGeneration;
    if (sessionGeneration === null) throw new SessionChangedError();
    authSessionLifecycle.assertCurrent(sessionGeneration);
    const flight = onboardingFlight.current;
    if (!flight || flight.generation !== sessionGeneration || flight.owner !== user?.user_id) return;
    if (onboardingCheck.current) return onboardingCheck.current.promise;
    const check = { controller: new AbortController(), promise: Promise.resolve() };
    onboardingCheck.current = check;
    setOnboardingSave({ status: 'checking', message: UNKNOWN_ONBOARDING_MESSAGE });
    const isCurrent = () => onboardingFlight.current === flight && authSessionLifecycle.isCurrent(sessionGeneration);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (async () => {
      const token = await getStorageItem('access_token');
      authSessionLifecycle.assertCurrent(sessionGeneration);
      if (check.controller.signal.aborted) throw new SessionChangedError();
      if (!token) throw new Error('No authenticated profile found. Please sign in again.');
      const profile = await fetchUserProfile(token, { owner: flight.owner, confirmOnboarding: true, sessionGeneration, signal: check.controller.signal, logErrors: false });
      if (!isCurrent()) return;
      if (profile?.user_id === flight.owner && profile.onboarding_completed === true) {
        flight.reconciled = true;
        // A newer confirmed read must not be undone by an older legacy read.
        flight.profileController?.abort();
        if (flight.settled) onboardingFlight.current = null;
        setOnboardingSave({ status: 'idle', message: null });
      } else if (profile?.user_id === flight.owner && profile.onboarding_completed === false
        && flight.settled && flight.casProtected && flight.expectedVersion !== undefined) {
        const currentVersion = onboardingProfileVersion(profile.profile_version);
        if (currentVersion === flight.expectedVersion) {
          flight.retryable = true;
          setOnboardingSave({ status: 'retryable', message: 'The save is not confirmed. Retry the originally submitted preferences safely, or check again.' });
        } else if (currentVersion !== undefined && BigInt(currentVersion) > BigInt(flight.expectedVersion)) {
          // The authoritative version has moved beyond the original CAS token;
          // even a still-running old server request can no longer commit it.
          onboardingFlight.current = null;
          setOnboardingSave({ status: 'idle', message: 'Your profile changed. Review your selections and choose Finish to save again.' });
        } else {
          setOnboardingSave({ status: 'unknown', message: UNKNOWN_ONBOARDING_MESSAGE });
        }
      } else {
        setOnboardingSave({ status: 'unknown', message: 'Your save is not confirmed yet and may still finish. Check save status again before trying to submit.' });
      }
    })();
    check.promise = Promise.race([read, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        check.controller.abort();
        reject(new Error('Save status check timed out. Check again when your connection recovers.'));
      }, ONBOARDING_SAVE_TIMEOUT_MS);
    })]).catch((error) => {
      if (isCurrent()) setOnboardingSave({ status: 'unknown', message: 'Could not confirm your save. It may have saved; check save status again before submitting.' });
      throw error;
    }).finally(() => {
      clearTimeout(timer);
      if (onboardingCheck.current === check) onboardingCheck.current = null;
    });
    return check.promise;
  }, [fetchUserProfile, user?.user_id, userGeneration]);

  const retryOnboarding = useCallback(async () => {
    const flight = onboardingFlight.current;
    if (!flight) throw new OnboardingOutcomeUnknownError();
    await completeOnboarding(flight.data, flight);
  }, [completeOnboarding]);

  const applySavedAvatar = useCallback((owner:string,generation:number,saved:{avatar_url:string;profile_version:string}) => {
    setUser(current => mergeSavedAvatar(current,owner,authSessionLifecycle.isCurrent(generation),saved));
  }, []);

  const updateUserProfile = useCallback((profile: EditableUserProfile) => {
    setUser((current) => mergeSavedUserProfile(current, profile));
  }, []);

  const adjustLikesGivenCount = useCallback((eventId: string, delta: -1 | 1) => {
    if (pendingLikesGivenEvents.current.has(eventId)) return;
    pendingLikesGivenEvents.current.set(eventId, delta);
    likesGivenRevision.current += 1;
    setUser((current) => current ? {
      ...current,
      likes_given_count: Math.max(0, Number(current.likes_given_count ?? 0) + delta),
    } : current);
  }, []);

  const settleLikesGivenCountAdjustments = useCallback((eventIds: readonly string[]) => {
    for (const eventId of eventIds) {
      const delta = pendingLikesGivenEvents.current.get(eventId);
      if (!delta) continue;
      pendingLikesGivenEvents.current.delete(eventId);
      likesGivenRevision.current += 1;
    }
  }, []);

  const setSession = useCallback(async ({
    accessToken,
    sessionGeneration,
  }: AuthenticatedSession<any>) => {
    authSessionLifecycle.assertCurrent(sessionGeneration);
    startupController.current?.abort();
    startupController.current = null;
    const storedToken = await getStorageItem('access_token');
    authSessionLifecycle.assertCurrent(sessionGeneration);
    if (storedToken !== accessToken) throw new SessionChangedError();

    clearAccountQueryCache(queryClient);
    pendingLikesGivenEvents.current.clear();
    likesGivenRevision.current += 1;
    setStartupError(null);
    setUser(null);
    setIsLoading(true);
    try {
      await fetchUserProfile(accessToken, { sessionGeneration });
    } finally {
      if (authSessionLifecycle.isCurrent(sessionGeneration)) setIsLoading(false);
    }
  }, [fetchUserProfile, queryClient]);

  const signOut = useCallback(async () => {
    startupController.current?.abort();
    startupController.current = null;
    setStartupError(null);
    const previousUser = user;
    const retirementGeneration=authSessionLifecycle.currentGeneration();
    if(previousUser){
      const retired=await retireFeedBeforeLogout({readToken:()=>getStorageItem('access_token'),
        retire:token=>feedSessions(token).endAll(),isCurrent:()=>authSessionLifecycle.isCurrent(retirementGeneration)});
      if(!retired)console.warn('Feed session retirement will retry when this account reconnects.');
    }
    if(!authSessionLifecycle.isCurrent(retirementGeneration))return;
    const logout = logoutRequest();
    const logoutGeneration = authSessionLifecycle.currentGeneration();
    clearAccountQueryCache(queryClient);
    pendingLikesGivenEvents.current.clear();
    likesGivenRevision.current += 1;
    setUser(null);
    setIsLoading(false);

    try {
      await logout;
    } catch (e) {
      if (e instanceof LogoutNotCompletedError) {
        if (authSessionLifecycle.isCurrent(logoutGeneration)) {
          if (e.restoreUserWhenPrepared) {
            // A pending marker write may still clear credentials. Restore only
            // after it confirms failure, and never over a newer auth transition.
            void e.restoreUserWhenPrepared.then((restore) => {
              if (restore && authSessionLifecycle.isCurrent(logoutGeneration)) {
                profileGeneration.current = logoutGeneration;
                setUser(previousUser);
              }
            }, () => undefined);
          } else {
            profileGeneration.current = logoutGeneration;
            setUser(previousUser);
          }
          throw e;
        }
        return;
      }
      console.error('Failed to revoke server session', e);
    }
  }, [user, queryClient]);

  useEffect(() => authSessionLifecycle.subscribe(() => {
    resetOnboardingSave();
    clearAccountQueryCache(queryClient);
    pendingLikesGivenEvents.current.clear();
    likesGivenRevision.current += 1;
    setUser(null);
    setIsLoading(false);
    setStartupError(null);
  }), [queryClient, resetOnboardingSave]);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      resetOnboardingSave();
      clearAccountQueryCache(queryClient);
      pendingLikesGivenEvents.current.clear();
      likesGivenRevision.current += 1;
      setUser(null);
    });
    return () => setSessionExpiredHandler(null);
  }, [queryClient, resetOnboardingSave]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadSession();
    }, 0);

    return () => { clearTimeout(timer); startupController.current?.abort(); };
  }, [loadSession]);

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      startupError,
      retryStartupSession: loadSession,
      setSession,
      signOut,
      checkOnboardingStatus,
      completeOnboarding,
      finishOnboarding: completeOnboarding,
      reconcileOnboarding,
      retryOnboarding,
      onboardingSave,
      updateUserProfile,
      applySavedAvatar,
      adjustLikesGivenCount,
      settleLikesGivenCountAdjustments,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
