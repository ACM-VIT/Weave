import GitHubIcon from '@/assets/icons/github.svg';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from 'react-native-reanimated';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react-native';
import { APP_THEME, REFERENCE_THEME } from '../../constants/theme';
import { githubImportApi } from '../../api/githubImport';
import { githubUnlinkApi } from '../../api/githubUnlink';
import { startGithubUnlink } from '../../services/githubUnlink';
import { startGithubReconnect } from '../../services/githubReconnect';
import { useModalScrollLock } from '../../hooks/use-modal-scroll-lock';
import { retireHomeFeedForGitHubChange } from '../../utils/feed-repository';

type Props = { visible: boolean; userId: string; onClose: () => void; onSaved: () => Promise<unknown> };
type Connection = { linked: boolean | null; active: boolean; pending: boolean; retryable: boolean; completed: boolean; message: string };
export function GitHubPreferencesPopup(props: Props) {
  if (!props.visible) return null;
  return <PopupBody key={props.userId} {...props} />;
}

function PopupBody({ userId, onClose, onSaved }: Props) {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const client = useQueryClient();
  const [state, setState] = useState<Connection & { busy: boolean; error: string }>({ linked: null, active: false, pending: false, retryable: false, completed: false, message: '', busy: true, error: '' });
  const [checks, setChecks] = useState(0);
  const alive = useRef(false), changed = useRef(false), sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  useModalScrollLock(true);

  const read = useCallback(async (signal: AbortSignal): Promise<Connection> => {
    const unlink = await githubUnlinkApi.status(signal, userId);
    const activity = await githubImportApi.status(signal, userId);
    return { linked: activity.linked, active: activity.active, pending: unlink.status === 'pending', retryable: unlink.retryable === true, completed: unlink.status === 'done' || unlink.status === 'refused' || unlink.status === 'superseded', message: unlink.message ?? '' };
  }, [userId]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController(); request.current = controller;
    const operation = ++sequence.current;
    const current = () => alive.current && !controller.signal.aborted && sequence.current === operation;
    read(controller.signal).then(async value => {
      if (!current()) return;
      if (value.completed && (!value.linked || !value.active)) {
        changed.current = true;
        await retireHomeFeedForGitHubChange(client, userId, current);
      }
      if (current()) setState({ ...value, busy: false, error: '' });
    }).catch(error => {
      if (alive.current && !controller.signal.aborted && sequence.current === operation) setState(current => ({ ...current, busy: false, error: error instanceof Error ? error.message : 'Could not load GitHub connection.' }));
    });
    return () => { alive.current = false; controller.abort(); request.current?.abort(); };
  }, [client, read, userId]);
  useEffect(() => {
    if (state.busy || !state.pending || checks >= 5) return;
    const controller = new AbortController();
    const operation = sequence.current;
    const timer = setTimeout(() => {
      const current = () => alive.current && !controller.signal.aborted && sequence.current === operation;
      read(controller.signal).then(async value => {
        if (!current()) return;
        if ((value.completed && (!value.linked || !value.active)) || value.linked !== state.linked || value.active !== state.active) {
          changed.current = true;
          await retireHomeFeedForGitHubChange(client, userId, current);
        }
        if (current()) setState(previous => ({ ...previous, ...value, message: value.message || (value.pending ? previous.message : ''), error: '' }));
      }).catch(() => undefined).finally(() => { if (current()) setChecks(count => count + 1); });
    }, 2_000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [checks, client, read, state.active, state.busy, state.linked, state.pending, userId]);

  const run = async (action: 'revoke' | 'connection') => {
    if (state.busy) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const operation = ++sequence.current;
    const current = () => alive.current && !controller.signal.aborted && sequence.current === operation;
    let operationMessage = '';
    const checking = state.linked === null || (state.pending && !state.retryable);
    setState(value => ({ ...value, busy: true, error: '' })); setChecks(0);
    try {
      if (!checking) {
        if (action === 'revoke') await githubImportApi.revoke(controller.signal, userId);
        else if (state.linked) {
          const result = await startGithubUnlink(userId, controller.signal);
          if (!result) return;
          operationMessage = result.message ?? '';
        } else if (!await startGithubReconnect(userId, controller.signal)) return;
        if (!current()) return;
        // A successful mutation must retire old pages even if its status read fails.
        changed.current = true;
        await retireHomeFeedForGitHubChange(client, userId, current);
      }
      if (!current()) return;
      const value = await read(controller.signal);
      if (!current()) return;
      if (checking && value.completed && (!value.linked || !value.active)) {
        changed.current = true;
        await retireHomeFeedForGitHubChange(client, userId, current);
      }
      if (current()) setState({ ...value, message: value.message || (value.pending ? operationMessage : ''), busy: false, error: '' });
    } catch (error) {
      if (current()) setState(value => ({ ...value, pending: value.linked !== null,
        retryable: false, message: 'Verifying whether the change completed…',
        error: error instanceof Error ? error.message : 'Could not update GitHub connection.' }));
    } finally { if (current()) setState(value => ({ ...value, busy: false })); }
  };
  const close = async () => {
    if (state.busy && sequence.current > 1) return;
    if (changed.current) {
      setState(value => ({ ...value, busy: true, error: '' }));
      try { await onSaved(); }
      catch { if (alive.current) setState(value => ({ ...value, busy: false, error: 'Could not refresh your account. Try closing again.' })); return; }
    }
    onClose();
  };
  const busy = state.busy;
  const verificationLabel = state.linked ? 'Verify disconnect' : 'Verify connection';
  const connectionLabel = state.linked === null ? 'Retry connection' : state.pending && checks >= 5 && !state.retryable
    ? verificationLabel : state.linked ? 'Disconnect' : 'Reconnect';
  const connectionDisabled = busy || (state.pending && !state.retryable && checks < 5);
  return <Modal visible transparent statusBarTranslucent animationType={reducedMotion ? 'none' : 'fade'} onRequestClose={() => void close()}>
    <View style={[styles.overlay, { paddingTop: Math.max(insets.top, 16), paddingBottom: Math.max(insets.bottom, 16) }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss GitHub preferences" onPress={() => void close()} style={StyleSheet.absoluteFill} />
      <View accessibilityViewIsModal style={styles.popup}>
        <View style={styles.header}>
          <GitHubIcon width={22} height={22} fill={APP_THEME.primary} />
          <Text accessibilityRole="header" style={styles.title}>GitHub</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close GitHub preferences" disabled={busy && sequence.current > 1} onPress={() => void close()} style={styles.close}>
            <X size={20} color={REFERENCE_THEME.textSecondary} />
          </Pressable>
        </View>
        <View style={styles.actions}>
          <Text style={styles.description}>Revoke removes imported GitHub preferences. {state.linked ? 'Disconnect removes GitHub sign-in.' : 'Reconnect restores GitHub sign-in.'}</Text>
          <Pressable cssInterop={false} accessibilityRole="button" accessibilityLabel="Revoke" disabled={busy || !state.active}
            accessibilityState={{ disabled: busy || !state.active }} onPress={() => void run('revoke')}
            style={[styles.button, styles.secondary, (busy || !state.active) && styles.disabled]}>
            <Text style={styles.secondaryLabel}>Revoke</Text>
          </Pressable>
          <Pressable cssInterop={false} accessibilityRole="button" accessibilityLabel={connectionLabel}
            disabled={connectionDisabled} accessibilityState={{ disabled: connectionDisabled, busy }}
            onPress={() => void run('connection')} style={[styles.button, { backgroundColor: state.linked ? REFERENCE_THEME.danger : APP_THEME.primary }, busy && styles.disabled]}>
            {busy ? <ActivityIndicator accessibilityLabel="Updating GitHub connection" color={state.linked ? REFERENCE_THEME.text : APP_THEME.primaryForeground} />
              : <Text style={[styles.connectionLabel, { color: state.linked ? REFERENCE_THEME.text : APP_THEME.primaryForeground }]}>{connectionLabel}</Text>}
          </Pressable>
          {state.pending ? <Text accessibilityLiveRegion="polite" style={styles.description}>
            {state.message || 'Disconnect is pending verification.'}{checks >= 5 ? ` Verification is still pending. Use ${verificationLabel} to check again.` : ''}
          </Text> : null}
          {state.error ? <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text> : null}
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20, backgroundColor: 'rgba(0,0,0,0.75)' },
  popup: { width: '100%', maxWidth: 380, backgroundColor: REFERENCE_THEME.surface, borderColor: REFERENCE_THEME.border, borderWidth: 1, borderRadius: 22, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 18, paddingRight: 10, paddingVertical: 10 },
  title: { flex: 1, fontFamily: 'NataSans-Bold', fontSize: 19, color: REFERENCE_THEME.text },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  actions: { paddingHorizontal: 16, paddingBottom: 16, gap: 10 },
  description: { color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 13, lineHeight: 19, marginBottom: 4 },
  button: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 12, paddingHorizontal: 16 },
  secondary: { backgroundColor: REFERENCE_THEME.surfaceElevated, borderWidth: 1, borderColor: REFERENCE_THEME.border },
  secondaryLabel: { color: REFERENCE_THEME.text, fontFamily: 'NataSans-SemiBold', fontSize: 15 },
  connectionLabel: { fontFamily: 'NataSans-SemiBold', fontSize: 15 },
  disabled: { opacity: 0.45 },
  error: { color: REFERENCE_THEME.textSecondary, fontFamily: 'NataSans-Regular', fontSize: 13, lineHeight: 18 },
});
