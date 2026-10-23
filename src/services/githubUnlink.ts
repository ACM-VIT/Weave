import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { githubUnlinkApi, type GithubUnlinkResult } from '../api/githubUnlink';
import { accessTokenOwner } from '../api/access-token-owner';
import { authSessionLifecycle, SessionChangedError } from '../api/session-lifecycle';
import { getStorageItem } from '../utils/storage';
import { createOAuthClientPkce } from './oauthClientPkce';
import { clearGithubUnlinkProof, saveGithubUnlinkProof, takeGithubUnlinkProof } from './githubUnlinkProof';

export async function assertGithubUnlinkOwner(owner: string, generation: number, signal: AbortSignal) {
  const token = await getStorageItem('access_token');
  authSessionLifecycle.assertCurrent(generation);
  if (signal.aborted || accessTokenOwner(token ?? '') !== owner) throw new SessionChangedError();
}
export async function finishGithubUnlink(owner: string, code: string, signal: AbortSignal): Promise<GithubUnlinkResult> {
  const generation = authSessionLifecycle.currentGeneration();
  await assertGithubUnlinkOwner(owner, generation, signal);
  const verifier = await takeGithubUnlinkProof(owner);
  await assertGithubUnlinkOwner(owner, generation, signal);
  const result = await githubUnlinkApi.finish(code, verifier, signal);
  await assertGithubUnlinkOwner(owner, generation, signal);
  return result;
}
export async function startGithubUnlink(owner: string, signal: AbortSignal): Promise<GithubUnlinkResult | null> {
  const generation = authSessionLifecycle.currentGeneration();
  try {
    await assertGithubUnlinkOwner(owner, generation, signal);
    const proof = await createOAuthClientPkce();
    await assertGithubUnlinkOwner(owner, generation, signal);
    await saveGithubUnlinkProof(owner, proof.verifier);
    await assertGithubUnlinkOwner(owner, generation, signal);
    const redirect = Linking.createURL('callback');
    const { url } = await githubUnlinkApi.start(proof.challenge, redirect, signal);
    await assertGithubUnlinkOwner(owner, generation, signal);
    const response = await WebBrowser.openAuthSessionAsync(url, redirect);
    await assertGithubUnlinkOwner(owner, generation, signal);
    if (response.type !== 'success') { await clearGithubUnlinkProof(); return null; }
    const params = Linking.parse(response.url).queryParams;
    if (params?.unlink_error === 'last_identity') throw new Error('GitHub is your only login identity. Add another login method before disconnecting it.');
    if (typeof params?.unlink_code !== 'string') throw new Error('GitHub reauthentication did not complete. Start again from your profile.');
    return await finishGithubUnlink(owner, params.unlink_code, signal);
  } catch (error) {
    // A previous account must never erase a newer account's pending verifier.
    if (authSessionLifecycle.isCurrent(generation)) await clearGithubUnlinkProof().catch(() => undefined);
    throw error;
  }
}
