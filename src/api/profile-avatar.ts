import { apiV2ForOwner } from './owner-request';
import { validateSavedPhoto, photoVersionHeader, type SavedPhoto } from '../services/profilePhotoFlow';
export async function uploadProfileAvatar(owner: string, bytes: ArrayBuffer, expectedVersion: unknown, signal?: AbortSignal): Promise<SavedPhoto> {
    const saved = await apiV2ForOwner<unknown>(owner, '/users/me/avatar', {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'If-Match': photoVersionHeader(expectedVersion) }, body: bytes, signal,
    });
    return validateSavedPhoto(saved, owner);
}
