import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { authSessionLifecycle } from '../api/session-lifecycle';

const key = 'github_unlink_client_pkce_v1';
type Proof = { owner: string; verifier: string; issuedAt: number };
let storageTail: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const task = storageTail.then(work, work);
  storageTail = task.catch(() => undefined);
  return task;
}
async function removeRaw() {
  if (Platform.OS === 'web') { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(key); }
  else await SecureStore.deleteItemAsync(key);
}
const remove = () => serial(removeRaw);
// A login/logout generation change retires purpose-specific material, including
// when an account switch happens while the provider browser is still open.
authSessionLifecycle.subscribe(() => { void remove().catch(() => undefined); });
export async function saveGithubUnlinkProof(owner: string, verifier: string) {
  const value = JSON.stringify({ owner, verifier, issuedAt: Date.now() } satisfies Proof);
  await serial(async () => {
    if (Platform.OS === 'web') sessionStorage.setItem(key, value);
    else await SecureStore.setItemAsync(key, value);
  });
}
export async function takeGithubUnlinkProof(owner: string): Promise<string> {
  return serial(async () => {
  const value = Platform.OS === 'web' ? sessionStorage.getItem(key) : await SecureStore.getItemAsync(key);
  await removeRaw();
  let proof: Proof | null = null;
  try { proof = value ? JSON.parse(value) : null; } catch { /* Invalid stored proof is retired. */ }
  if (!proof || proof.owner !== owner || !/^[A-Za-z0-9._~-]{43,128}$/.test(proof.verifier)
    || !Number.isSafeInteger(proof.issuedAt) || proof.issuedAt > Date.now() + 5_000 || Date.now() - proof.issuedAt >= 300_000) {
    throw new Error('This disconnect attempt expired or belongs to another account. Start again from your profile.');
  }
  return proof.verifier;
  });
}
export const clearGithubUnlinkProof = remove;
