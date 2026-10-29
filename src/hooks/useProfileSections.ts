import { throwIfAborted } from '../utils/abort-signal';
import { useQuery } from '@tanstack/react-query';
import { getProfileCollections } from '../api/profile';
import { profileSectionQueries } from '../api/profile-section-queries';
import { getStorageItem } from '../utils/storage';

async function tokenForRequest(signal: AbortSignal): Promise<string> {
  const token = await getStorageItem('access_token');
  throwIfAborted(signal);
  if (!token) throw new Error('Your session has expired. Please log in again.');
  return token;
}

export function useProfileSections(viewer: string | undefined) {
  const options = profileSectionQueries(viewer, {
    collections: async signal => getProfileCollections(await tokenForRequest(signal), signal),
  });
  return { collections: useQuery(options.collections) };
}
