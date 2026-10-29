import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { APP_THEME, Fonts, REFERENCE_THEME, Spacing } from '../../constants/theme';
import { githubUnlinkApi, type GithubUnlinkResult } from '../../api/githubUnlink';
import { startGithubUnlink } from '../../services/githubUnlink';

type Props = { recoveryOnly?: boolean; userId: string; onSaved: () => Promise<unknown>; authorize?: typeof startGithubUnlink; api?: typeof githubUnlinkApi };
function UnlinkAction({ label, onPress, disabled, destructive = false }: { label: string; onPress: () => void; disabled: boolean; destructive?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => ({ minHeight: 48, justifyContent: 'center', alignItems: 'center', padding: Spacing.three, borderRadius: 12, borderWidth: 1, borderColor: destructive ? REFERENCE_THEME.danger : REFERENCE_THEME.border, backgroundColor: destructive ? REFERENCE_THEME.danger : REFERENCE_THEME.surfaceElevated, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 })}>
    <Text style={{ color: destructive ? REFERENCE_THEME.text : REFERENCE_THEME.textStrong, fontFamily: Fonts.sans, fontSize: 15, textAlign: 'center' }}>{label}</Text>
  </Pressable>;
}
export function GitHubUnlinkPanel(props: Props) { return <UnlinkBody key={props.userId} {...props} />; }
function UnlinkBody({ userId, onSaved, recoveryOnly = false, authorize = startGithubUnlink, api = githubUnlinkApi }: Props) {
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<GithubUnlinkResult | null>(null);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(false), request = useRef<AbortController | null>(null), sequence = useRef(0);
  const saved = useRef(onSaved);
  useEffect(() => { saved.current = onSaved; }, [onSaved]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController(), operation = ++sequence.current;
    api.status(controller.signal, userId).then(async value => {
      if (!alive.current || controller.signal.aborted || operation !== sequence.current) return;
      setResult(value);
      if (value.status !== 'none') await saved.current();
    })
      .catch(reason => { if (alive.current && !controller.signal.aborted && operation === sequence.current) setError(reason.message); });
    return () => { alive.current = false; controller.abort(); request.current?.abort(); };
  }, [api, userId]);
  const run = async (check: boolean) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const operation = ++sequence.current;
    const isCurrent = () => alive.current && !controller.signal.aborted && operation === sequence.current;
    setBusy(true); setError('');
    try {
      const value = check ? await api.status(controller.signal, userId) : await authorize(userId, controller.signal);
      if (!isCurrent()) return;
      if (value) { setResult(value); if (value.status !== 'none') await onSaved(); }
    } catch (reason) { if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Unable to verify disconnect. Check status again.'); }
    finally { if (isCurrent()) setBusy(false); }
  };
  if (recoveryOnly && result?.status !== 'pending' && !error) return null;
  const content = <View style={{ gap: Spacing.two, paddingVertical: Spacing.three }}>
    <Text style={{ color: REFERENCE_THEME.text, fontFamily: Fonts.sans, fontWeight: '600', fontSize: 17 }}>GitHub login</Text>
    <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans, fontSize: 14, lineHeight: 21 }}>
      Disconnecting requires another login identity and a fresh GitHub sign-in for this account. It also revokes imported activity preferences. Your manual preferences, saves and lists stay in Weave.
    </Text>
    {recoveryOnly && result?.status !== 'pending' ? null : result?.status === 'done' ? <Text style={{ color: REFERENCE_THEME.text, fontFamily: Fonts.sans }}>GitHub login disconnected.</Text> : <>
      {result?.status === 'pending' ? <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans }}>{result.message ?? 'Disconnect is pending verification. Activity imports are paused.'}</Text> : null}
      {result?.status === 'refused' ? <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans }}>The provider refused the disconnect. GitHub remains linked; imported preferences were revoked.</Text> : null}
      {result?.status === 'superseded' ? <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans }}>Your GitHub identity changed. The newer login was preserved.</Text> : null}
      {(result?.status !== 'pending' || result.retryable === true) ? <>{confirmed ? <UnlinkAction destructive label={result?.status === 'pending' ? 'Reauthenticate and retry disconnect' : 'Reauthenticate and disconnect GitHub'} onPress={() => { void run(false); }} disabled={busy} />
        : <UnlinkAction destructive label={result?.status === 'pending' ? 'Retry pending GitHub disconnect' : 'Disconnect GitHub login'} onPress={() => setConfirmed(true)} disabled={busy} />}
      {confirmed ? <UnlinkAction label={result?.status === 'pending' ? 'Back to disconnect status' : 'Keep GitHub login'} onPress={() => setConfirmed(false)} disabled={busy} /> : null}</> : null}
    </>}
    <UnlinkAction label="Check disconnect status" onPress={() => { void run(true); }} disabled={busy} />
    {busy ? <ActivityIndicator accessibilityLabel="Verifying GitHub disconnect" color={APP_THEME.primary} /> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: REFERENCE_THEME.text, fontFamily: Fonts.sans }}>{error}</Text> : null}
  </View>;
  return recoveryOnly ? <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, maxHeight: '45%' }}
    contentContainerStyle={{ paddingTop: insets.top, paddingHorizontal: Spacing.four, maxWidth: 450, width: '100%', alignSelf: 'center' }}>
    {content}
  </ScrollView> : content;
}
