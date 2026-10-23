import { apiV2 } from './client';
import { accessTokenOwner } from './access-token-owner';
import { authSessionLifecycle, SessionChangedError } from './session-lifecycle';
import { getStorageItem } from '../utils/storage';

/** Bind deferred UI work to its account before allowing authenticated I/O. */
export async function apiV2ForOwner<T>(owner: string, path: string, options: RequestInit = {}): Promise<T> {
  const generation = authSessionLifecycle.currentGeneration();
  const token = await getStorageItem('access_token');
  authSessionLifecycle.assertCurrent(generation);
  if (!token || accessTokenOwner(token) !== owner) throw new SessionChangedError();
  if (options.signal?.aborted) throw Object.assign(new Error('Request cancelled.'), { name: 'AbortError' });
  return apiV2<T>(path, options, token);
}
