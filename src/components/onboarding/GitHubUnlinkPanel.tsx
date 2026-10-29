import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { APP_THEME, Fonts, REFERENCE_THEME, Spacing } from '../../constants/theme';
import { githubUnlinkApi, type GithubUnlinkResult } from '../../api/githubUnlink';
import { startGithubUnlink } from '../../services/githubUnlink';

type Props = { recoveryOnly?: boolean; linked?: boolean; userId: string; onSaved: () => Promise<unknown>; authorize?: typeof startGithubUnlink; api?: typeof githubUnlinkApi };
function UnlinkAction({ label, onPress, disabled, destructive = false }: { label: string; onPress: () => void; disabled: boolean; destructive?: boolean }) {
  return <Pressable cssInterop={false} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => ({ minHeight: 48, justifyContent: 'center', alignItems: 'center', padding: Spacing.three, borderRadius: 12, borderWidth: 1, borderColor: destructive ? REFERENCE_THEME.danger : REFERENCE_THEME.border, backgroundColor: destructive ? REFERENCE_THEME.danger : REFERENCE_THEME.surfaceElevated, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 })}>
    <Text style={{ color: destructive ? REFERENCE_THEME.text : REFERENCE_THEME.textStrong, fontFamily: Fonts.sans, fontSize: 15, textAlign: 'center' }}>{label}</Text>
  </Pressable>;
}
export function GitHubUnlinkPanel(props: Props) { return <UnlinkBody key={props.userId} {...props} />; }
function UnlinkBody({ userId, onSaved, linked, recoveryOnly = false, authorize = startGithubUnlink, api = githubUnlinkApi }: Props) {
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<GithubUnlinkResult | null>(null);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [automaticChecks, setAutomaticChecks] = useState(0);
  const alive = useRef(false), request = useRef<AbortController | null>(null), sequence = useRef(0);
  const saved = useRef(onSaved);
  useEffect(() => { saved.current = onSaved; }, [onSaved]);
  const run = useCallback(async (check: boolean) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const operation = ++sequence.current;
    const isCurrent = () => alive.current && !controller.signal.aborted && operation === sequence.current;
    setBusy(true); setError('');
    if (!check) setAutomaticChecks(0);
    try {
      const value = check ? await api.status(controller.signal, userId) : await authorize(userId, controller.signal);
      if (!isCurrent()) return;
      if (value) { setResult(value); if (value.status !== 'none') await saved.current(); }
    } catch (reason) { if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Unable to verify disconnect. Reopen this panel to retry.'); }
    finally { if (isCurrent()) setBusy(false); }
  }, [api, authorize, userId]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController(); request.current = controller;
    const operation = ++sequence.current;
    const isCurrent = () => alive.current && !controller.signal.aborted && operation === sequence.current;
    api.status(controller.signal, userId).then(async value => {
      if (!isCurrent()) return;
      setResult(value);
      if (value.status !== 'none') await saved.current();
    }).catch(reason => { if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Unable to verify disconnect.'); })
      .finally(() => { if (isCurrent()) setBusy(false); });
    return () => { alive.current = false; controller.abort(); request.current?.abort(); };
  }, [api, userId]);
  useEffect(() => {
    if (busy || automaticChecks >= 5 || (result?.status !== 'pending' && !error)) return;
    const timer = setTimeout(() => { setAutomaticChecks(count => count + 1); void run(true); }, 2_000);
    return () => clearTimeout(timer);
  }, [automaticChecks, busy, error, result?.status, run]);
  if (recoveryOnly && result?.status !== 'pending' && !error) return null;
  const content = <View style={{ gap: Spacing.two, paddingVertical: Spacing.three }}>
    <Text style={{ color: REFERENCE_THEME.text, fontFamily: Fonts.sans, fontWeight: '600', fontSize: 17 }}>GitHub login</Text>
    <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans, fontSize: 14, lineHeight: 21 }}>
      Disconnecting requires another login identity and a fresh GitHub sign-in for this account. It also revokes imported activity preferences. Your manual preferences, saves and lists stay in Weave.
    </Text>
    {recoveryOnly && result?.status !== 'pending' ? null : result?.status === 'done' ? <Text style={{ color: REFERENCE_THEME.text, fontFamily: Fonts.sans }}>GitHub login disconnected.</Text> : linked === false && result?.status !== 'pending' ? <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans }}>No GitHub login is connected.</Text> : <>
      {result?.status === 'pending' ? <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans }}>{result.message ?? 'Disconnect is pending verification. Activity imports are paused.'}</Text> : null}
      {result?.status === 'refused' ? <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans }}>The provider refused the disconnect. GitHub remains linked; imported preferences were revoked.</Text> : null}
      {result?.status === 'superseded' ? <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans }}>Your GitHub identity changed. The newer login was preserved.</Text> : null}
      {(result?.status !== 'pending' || result.retryable === true) ? <>{confirmed ? <UnlinkAction destructive label={result?.status === 'pending' ? 'Reauthenticate and retry disconnect' : 'Reauthenticate and disconnect GitHub'} onPress={() => { void run(false); }} disabled={busy} />
        : <UnlinkAction destructive label={result?.status === 'pending' ? 'Retry pending GitHub disconnect' : 'Disconnect GitHub login'} onPress={() => setConfirmed(true)} disabled={busy} />}
      {confirmed ? <UnlinkAction label={result?.status === 'pending' ? 'Back to disconnect status' : 'Keep GitHub login'} onPress={() => setConfirmed(false)} disabled={busy} /> : null}</> : null}
    </>}
    {!recoveryOnly ? <>
      <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans, fontSize: 13, lineHeight: 19 }}>Disconnecting removes the login connection in Weave. To also revoke the app authorization on GitHub, remove it in GitHub Settings.</Text>
      <UnlinkAction label="GitHub authorization settings" onPress={() => { void Linking.openURL('https://github.com/settings/applications').catch(() => setError('Could not open GitHub Settings. Try again.')); }} disabled={busy} />
    </> : null}
    {automaticChecks >= 5 && !busy && result?.status === 'pending' ? <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans }}>Verification is still pending. Reopen this panel to check again, or reauthenticate to retry.</Text> : null}
    {busy ? <ActivityIndicator accessibilityLabel="Verifying GitHub disconnect" color={APP_THEME.primary} /> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: REFERENCE_THEME.text, fontFamily: Fonts.sans }}>{error}</Text> : null}
  </View>;
  return recoveryOnly ? <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, maxHeight: '45%' }}
    contentContainerStyle={{ paddingTop: insets.top, paddingHorizontal: Spacing.four, maxWidth: 450, width: '100%', alignSelf: 'center' }}>
    {content}
  </ScrollView> : content;
}
