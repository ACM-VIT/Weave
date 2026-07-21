import { apiV2 } from './client';
import { getStorageItem } from '../utils/storage';

export interface CommentRecord {
  comment_id: string;
  user_id: string;
  repo_id: string;
  parent_comment_id: string | null;
  comment: string;
  created_at: string | null;
  author?: CommentAuthor;
}

export interface CommentAuthor {
  user_id: string;
  username: string;
  full_name?: string | null;
  avatar_url?: string | null;
}

export interface CreateCommentInput {
  repoId: string;
  comment: string;
  parentCommentId?: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeComment(value: unknown): CommentRecord | null {
  if (!isObject(value)) return null;

  const commentId = value.comment_id;
  const userId = value.user_id;
  const repoId = value.repo_id;
  const body = value.comment ?? value.body;

  if (
    typeof commentId !== 'string' ||
    typeof userId !== 'string' ||
    typeof repoId !== 'string' ||
    typeof body !== 'string'
  ) {
    return null;
  }

  const author = typeof value.username === 'string' ? {
    user_id: userId,
    username: value.username,
    full_name: typeof value.full_name === 'string' ? value.full_name : null,
    avatar_url: typeof value.avatar_url === 'string' ? value.avatar_url : null,
  } : undefined;

  return {
    comment_id: commentId,
    user_id: userId,
    repo_id: repoId,
    parent_comment_id:
      typeof value.parent_comment_id === 'string' ? value.parent_comment_id : null,
    comment: body,
    created_at: typeof value.created_at === 'string' ? value.created_at : null,
    ...(author ? { author } : {}),
  };
}

export async function getCommentsByRepo(
  repoId: string,
  signal?: AbortSignal,
): Promise<CommentRecord[]> {
  const normalizedRepoId = repoId.trim();
  if (!normalizedRepoId) return [];

  const token = await getStorageItem('access_token');
  if (!token) throw new Error('Your session has expired.');
  const data = await apiV2<{ items: unknown[] }>(
    `/repositories/${encodeURIComponent(normalizedRepoId)}/comments?limit=100&offset=0`, { signal }, token,
  );
  if (!Array.isArray(data.items)) {
    throw new Error('Comments response was not a list');
  }

  return data.items
    .map(normalizeComment)
    .filter((comment): comment is CommentRecord => comment !== null);
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
