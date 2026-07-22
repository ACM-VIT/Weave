import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';

const LOCAL_BACKEND_PORT = 5000;

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

export const getApiUrl = (): string => {
  // 1. Production / User-defined environment variable (Highest Priority)
  // Local Android release builds inject this explicitly through the artifact script.
  if (process.env.EXPO_PUBLIC_BACKEND_URL) {
    return withoutTrailingSlash(process.env.EXPO_PUBLIC_BACKEND_URL);
  }

  // 2. Development fallbacks (if no env variable is provided)
  if (process.env.NODE_ENV !== 'production') {
    // Android emulators reach services on the host machine through 10.0.2.2.
    // A LAN address can be blocked by host firewall rules even when Metro works.
    if (Platform.OS === 'android' && !Device.isDevice) {
      return `http://10.0.2.2:${LOCAL_BACKEND_PORT}/api`;
    }

    if (Platform.OS === 'web') {
      return `http://localhost:${LOCAL_BACKEND_PORT}/api`;
    }

    // Physical devices use the same LAN host that served the Expo bundle.
    if (Constants.expoConfig?.hostUri) {
      return `http://${Constants.expoConfig.hostUri.split(':')[0]}:${LOCAL_BACKEND_PORT}/api`;
    }

    // Fallback for iOS Simulator or Web
    return `http://localhost:${LOCAL_BACKEND_PORT}/api`;
  }

  // 3. Final Production Fallback
  // If we reach here in production, it means the developer forgot to set the environment variable.
  // We log an explicit error to fail fast but return a dummy URL so the app gracefully shows the 
  // 'Service Unavailable' screen instead of fatally crashing during module load.
  console.error('CRITICAL: EXPO_PUBLIC_BACKEND_URL environment variable is missing. You must configure this in your production environment.');
  return 'http://MISSING_CONFIG';
};

export const API_URL = getApiUrl();
