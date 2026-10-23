import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { APP_THEME, Fonts, REFERENCE_THEME, Spacing } from '../../constants/theme';
import { githubUnlinkApi, type GithubUnlinkResult } from '../../api/githubUnlink';
import { startGithubUnlink } from '../../services/githubUnlink';

type Props = { userId: string; onSaved: () => Promise<unknown>; authorize?: typeof startGithubUnlink; api?: typeof githubUnlinkApi };
function UnlinkAction({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={{ minHeight: 48, justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}>
    <Text style={{ color: APP_THEME.primary, fontFamily: Fonts.sans, fontSize: 15 }}>{label}</Text>
  </Pressable>;
}
export function GitHubUnlinkPanel(props: Props) { return <UnlinkBody key={props.userId} {...props} />; }
function UnlinkBody({ userId, onSaved, authorize = startGithubUnlink, api = githubUnlinkApi }: Props) {
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
  return <View style={{ gap: Spacing.two, paddingVertical: Spacing.three }}>
    <Text style={{ color: REFERENCE_THEME.text, fontFamily: Fonts.sans, fontWeight: '600', fontSize: 17 }}>GitHub login</Text>
    <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans, fontSize: 14, lineHeight: 21 }}>
      Disconnecting requires another login identity and a fresh GitHub sign-in for this account. It also revokes imported activity preferences. Your manual preferences, saves and lists stay in Weave.
    </Text>
    {result?.status === 'done' ? <Text style={{ color: REFERENCE_THEME.text, fontFamily: Fonts.sans }}>GitHub login disconnected.</Text> : <>
      {result?.status === 'pending' ? <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans }}>{result.message ?? 'Disconnect is pending verification. Activity imports are paused.'}</Text> : null}
      {result?.status === 'refused' ? <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans }}>The provider refused the disconnect. GitHub remains linked; imported preferences were revoked.</Text> : null}
      {result?.status === 'superseded' ? <Text style={{ color: REFERENCE_THEME.textSecondary, fontFamily: Fonts.sans }}>Your GitHub identity changed. The newer login was preserved.</Text> : null}
      {result?.status !== 'pending' ? <>{confirmed ? <UnlinkAction label="Reauthenticate and disconnect GitHub" onPress={() => { void run(false); }} disabled={busy} />
        : <UnlinkAction label="Disconnect GitHub login" onPress={() => setConfirmed(true)} disabled={busy} />}
      {confirmed ? <UnlinkAction label="Keep GitHub login" onPress={() => setConfirmed(false)} disabled={busy} /> : null}</> : null}
    </>}
    <UnlinkAction label="Check disconnect status" onPress={() => { void run(true); }} disabled={busy} />
    {busy ? <ActivityIndicator accessibilityLabel="Verifying GitHub disconnect" color={APP_THEME.primary} /> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: REFERENCE_THEME.text, fontFamily: Fonts.sans }}>{error}</Text> : null}
  </View>;
}
