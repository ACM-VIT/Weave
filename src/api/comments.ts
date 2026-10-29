import { throwIfAborted } from '../utils/abort-signal';
import { apiV2 } from './client';
import { getStorageItem } from '../utils/storage';

import { normalizeComment, requestCommentsPage, requestCommentsKeysetPage, type CommentAuthor, type CommentRecord, type CommentsPage } from './comments-data';
export type { CommentAuthor, CommentRecord, CommentsPage } from './comments-data';

export interface CreateCommentInput {
  repoId: string;
  comment: string;
  parentCommentId?: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function getCommentsByRepo(
  repoId: string,
  offset = 0,
  signal?: AbortSignal,
): Promise<CommentsPage> {
  const token = await getStorageItem('access_token');
  if (!token) throw new Error('Your session has expired.');
  return requestCommentsPage(repoId, offset, path => apiV2<{ items: unknown[] }>(path, { signal }, token));
}

export async function createComment(
  input: CreateCommentInput,
  token: string,
): Promise<CommentRecord> {
  const body = input.comment.trim();
  if (!input.repoId.trim() || !body) {
    throw new Error('A repository and comment are required');
  }

  const data = await apiV2<unknown>(`/repositories/${encodeURIComponent(input.repoId)}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      body,
      ...(input.parentCommentId
        ? { parent_comment_id: input.parentCommentId }
        : {}),
    }),
  }, token);
  const comment = normalizeComment(data);
  if (!comment) {
    throw new Error('Comment response was invalid');
  }

  return comment;
}

export async function getCommentAuthor(
  userId: string,
  signal?: AbortSignal,
): Promise<CommentAuthor> {
  const token = await getStorageItem('access_token');
  if (!token) throw new Error('Your session has expired.');
  const data = await apiV2<unknown>(`/users/${encodeURIComponent(userId)}`, { signal }, token);
  if (!isObject(data) || typeof data.user_id !== 'string' || typeof data.username !== 'string') {
    throw new Error('Comment author response was invalid');
  }

  return {
    user_id: data.user_id,
    username: data.username,
    full_name: typeof data.full_name === 'string' ? data.full_name : null,
    avatar_url: typeof data.avatar_url === 'string' ? data.avatar_url : null,
  };
}

export async function getCommentsKeysetPage(repoId: string, cursor: string | null, signal?: AbortSignal) {
  const token = await getStorageItem('access_token');
  throwIfAborted(signal);
  if (!token) throw new Error('Your session has expired.');
  return requestCommentsKeysetPage(repoId, cursor, path => apiV2<unknown>(path, { signal }, token));
}
