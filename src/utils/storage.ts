import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

function getWebStorage(key: string): Storage {
  if (key === 'access_token' && typeof sessionStorage !== 'undefined') return sessionStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  throw new Error('Browser storage is unavailable');
}

export async function setStorageItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      getWebStorage(key).setItem(key, value);
    } catch (e) {
      console.error('Local storage error:', e);
      throw e;
    }
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}

export async function getStorageItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return getWebStorage(key).getItem(key);
    } catch (e) {
      console.error('Local storage is unavailable:', e);
    }
    return null;
  } else {
    return await SecureStore.getItemAsync(key);
  }
}

export async function getStorageItemStrict(key: string): Promise<string | null> {
  if (Platform.OS === 'web') return getWebStorage(key).getItem(key);
  return SecureStore.getItemAsync(key);
}

export async function removeStorageItem(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      getWebStorage(key).removeItem(key);
    } catch (e) {
      console.error('Local storage error:', e);
      throw e;
    }
  } else {
    await SecureStore.deleteItemAsync(key);
  }
}

// Legacy aliases to maintain backward compatibility across the rest of the app
export const setItemAsync = setStorageItem;
export const getItemAsync = getStorageItem;
export const deleteItemAsync = removeStorageItem;
