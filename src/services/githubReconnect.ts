import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { getOAuthUrl } from '../api/auth';
import { apiV2ForOwner } from '../api/owner-request';
import { accessTokenOwner } from '../api/access-token-owner';
import { authSessionLifecycle, SessionChangedError } from '../api/session-lifecycle';
import { getStorageItem } from '../utils/storage';
import { createOAuthClientPkce } from './oauthClientPkce';
import { clearGithubReconnectProof, saveGithubReconnectProof, takeGithubReconnectProof } from './githubUnlinkProof';

async function assertOwner(owner: string, generation: number, signal: AbortSignal) {
  const token = await getStorageItem('access_token');
  authSessionLifecycle.assertCurrent(generation);
  if (signal.aborted || accessTokenOwner(token ?? '') !== owner) throw new SessionChangedError();
}
const completions = new Map<string, { expiresAt: number; request: Promise<{ status: 'done' }> }>();
authSessionLifecycle.subscribe(() => completions.clear());

export async function finishGithubReconnect(owner: string, code: string, signal: AbortSignal) {
  const generation = authSessionLifecycle.currentGeneration();
  await assertOwner(owner, generation, signal);
  // Native deep-link routing and the browser promise can deliver the same
  // result. Give them one completion, including a late callback after success.
  const now = Date.now();
  for (const [key, value] of completions) if (value.expiresAt <= now) completions.delete(key);
  const key = `${generation}:${owner}:${code}`;
  const existing = completions.get(key);
  if (existing) return existing.request;
  const request = (async () => {
    const verifier = await takeGithubReconnectProof(owner);
    await assertOwner(owner, generation, signal);
    await apiV2ForOwner(owner, '/onboarding/github-reconnect', {
      method: 'POST', body: JSON.stringify({ code, code_verifier: verifier }), signal,
    });
    await assertOwner(owner, generation, signal);
    return { status: 'done' as const };
  })();
  completions.set(key, { expiresAt: now + 300_000, request });
  void request.catch(() => { if (completions.get(key)?.request === request) completions.delete(key); });
  return request;
}

/** Reauthenticate the same account without replacing its token or refresh cookie. */
export async function startGithubReconnect(owner: string, signal: AbortSignal): Promise<boolean> {
  const generation = authSessionLifecycle.currentGeneration();
  try {
    await assertOwner(owner, generation, signal);
    const proof = await createOAuthClientPkce();
    await assertOwner(owner, generation, signal);
    await saveGithubReconnectProof(owner, proof.verifier);
    await assertOwner(owner, generation, signal);
    const redirect = Linking.createURL('callback', { queryParams: { github_reconnect: '1' } });
    const url = await getOAuthUrl('github', redirect, proof.challenge, 'login');
    await assertOwner(owner, generation, signal);
    const response = await WebBrowser.openAuthSessionAsync(url, redirect);
    await assertOwner(owner, generation, signal);
    if (response.type !== 'success') { await clearGithubReconnectProof(); return false; }
    const params = Linking.parse(response.url).queryParams;
    if (typeof params?.code !== 'string') throw new Error('GitHub reconnection did not complete. Your current session has been kept.');
    await finishGithubReconnect(owner, params.code, signal);
    return true;
  } catch (error) {
    if (authSessionLifecycle.isCurrent(generation)) await clearGithubReconnectProof().catch(() => undefined);
    throw error;
  }
}
