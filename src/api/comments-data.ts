export const COMMENTS_PAGE_SIZE = 25;

export interface CommentsPage {
  items: CommentRecord[];
  nextOffset: number | undefined;
}

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeComment(value: unknown): CommentRecord | null {
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

export function normalizeCommentsPage(items: unknown[], offset: number): CommentsPage {
  return {
    items: items.map(normalizeComment).filter((comment): comment is CommentRecord => comment !== null),
    // Advance by server rows, not valid/deduplicated/optimistic display rows.
    nextOffset: items.length === COMMENTS_PAGE_SIZE ? offset + items.length : undefined,
  };
}

export function mergeCommentPages(pages: readonly CommentsPage[], local: readonly CommentRecord[] = []): CommentRecord[] {
  const byId = new Map<string, CommentRecord>();
  for (const comment of [...pages.flatMap(page => page.items), ...local]) {
    if (!byId.has(comment.comment_id)) byId.set(comment.comment_id, comment);
  }
  return [...byId.values()];
}

export async function requestCommentsPage(
  repoId: string,
  offset: number,
  send: (path: string) => Promise<{ items: unknown[] }>,
): Promise<CommentsPage> {
  if (!repoId.trim()) return { items: [], nextOffset: undefined };
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid comments offset');
  const data = await send(`/repositories/${encodeURIComponent(repoId.trim())}/comments?limit=${COMMENTS_PAGE_SIZE}&offset=${offset}`);
  if (!Array.isArray(data.items)) throw new Error('Comments response was not a list');
  return normalizeCommentsPage(data.items, offset);
}

export const commentAuthorKey = (viewer: string | undefined, authorId: string) => ['comment-author', viewer, authorId] as const;

export function commentAuthorOptions(viewer: string | undefined, authorId: string,
  send: (authorId: string, signal: AbortSignal) => Promise<CommentAuthor>) {
  return {
    queryKey: commentAuthorKey(viewer, authorId),
    queryFn: ({ signal }: { signal: AbortSignal }) => send(authorId, signal),
    staleTime: 5 * 60_000,
    retry: false as const,
  };
}
