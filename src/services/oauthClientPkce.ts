import * as Crypto from 'expo-crypto';

import { getStorageItem, removeStorageItem, setStorageItem } from '../utils/storage';

const OAUTH_VERIFIER_STORAGE_KEY = 'oauth_client_code_verifier_v1';

function base64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createOAuthClientPkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = bytesToHex(await Crypto.getRandomBytesAsync(32));
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  return { verifier, challenge: base64Url(digest) };
}

export async function persistOAuthClientVerifier(verifier: string): Promise<void> {
  await setStorageItem(OAUTH_VERIFIER_STORAGE_KEY, verifier);
}

export async function loadOAuthClientVerifier(): Promise<string | null> {
  return getStorageItem(OAUTH_VERIFIER_STORAGE_KEY);
}

export async function clearOAuthClientVerifier(): Promise<void> {
  await removeStorageItem(OAUTH_VERIFIER_STORAGE_KEY);
}
