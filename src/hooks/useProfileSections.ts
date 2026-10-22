import { useQuery } from '@tanstack/react-query';
import { getProfileBoards, getProfileCollections } from '../api/profile';
import { profileSectionQueries } from '../api/profile-section-queries';
import { getStorageItem } from '../utils/storage';

async function tokenForRequest(signal: AbortSignal): Promise<string> {
  const token = await getStorageItem('access_token');
  signal.throwIfAborted();
  if (!token) throw new Error('Your session has expired. Please log in again.');
  return token;
}

export function useProfileSections(viewer: string | undefined) {
  const options = profileSectionQueries(viewer, {
    boards: async signal => getProfileBoards(await tokenForRequest(signal), signal),
    collections: async signal => getProfileCollections(await tokenForRequest(signal), signal),
  });
  return {
    boards: useQuery(options.boards),
    collections: useQuery(options.collections),
  };
}
