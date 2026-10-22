import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { commentAuthorOptions, requestCommentsPage, COMMENTS_PAGE_SIZE, mergeCommentPages, normalizeCommentsPage } from '../src/api/comments-data';

const row = (id: number, author = id % 3) => ({
  comment_id: String(id), repo_id: 'repo', user_id: `author-${author}`, body: `Comment ${id}`,
  created_at: '2026-10-22T00:00:00Z', username: `user-${author}`,
});

test('bounded pages advance by raw server rows and local mutations do not alter pagination', () => {
  const rows = Array.from({ length: 62 }, (_, index) => row(index));
  const first = normalizeCommentsPage(rows.slice(0, COMMENTS_PAGE_SIZE), 0);
  assert.equal(first.items.length, 25);
  assert.equal(first.nextOffset, 25);
  const saved = normalizeCommentsPage([row(62)], 0).items[0];
  const second = normalizeCommentsPage(rows.slice(first.nextOffset, 50), first.nextOffset!);
  const third = normalizeCommentsPage([...rows.slice(50), row(62)], second.nextOffset!);
  assert.equal(second.nextOffset, 50);
  assert.equal(third.nextOffset, undefined);
  const comments = mergeCommentPages([first, second, third], [saved]);
  assert.deepEqual(comments.map(comment => comment.comment_id), Array.from({ length: 63 }, (_, index) => String(index)));
  assert.equal(new Set(comments.map(comment => comment.author?.user_id)).size, 3);
  const malformed = normalizeCommentsPage([...rows.slice(0, 24), {}], 0);
  assert.equal(malformed.items.length, 24);
  assert.equal(malformed.nextOffset, 25);
});

test('comment requests stay bounded and author cache entries survive page and repository changes', async () => {
  const rows = Array.from({ length: 61 }, (_, index) => row(index, index < 40 ? index % 3 : index));
  const paths: string[] = [];
  const pages = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = await requestCommentsPage('repo', offset, async path => {
      paths.push(path);
      const params = new URL(path, 'https://example.test').searchParams;
      const start = Number(params.get('offset'));
      return { items: rows.slice(start, start + Number(params.get('limit'))) };
    });
    pages.push(page);
    offset = page.nextOffset;
  }
  assert.deepEqual(paths, [0, 25, 50].map(offset => `/repositories/repo/comments?limit=25&offset=${offset}`));
  assert.equal(mergeCommentPages(pages).length, 61);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const requests: string[] = [];
  const send = async (authorId: string) => {
    requests.push(authorId);
    return { user_id: authorId, username: authorId };
  };
  for (const page of pages) {
    await Promise.all(page.items.map(comment => client.fetchQuery(commentAuthorOptions('viewer', comment.user_id, send))));
  }
  const distinct = new Set(rows.map(row => row.user_id));
  assert.equal(requests.length, distinct.size);
  await client.fetchQuery(commentAuthorOptions('viewer', rows[0].user_id, send));
  assert.equal(requests.length, distinct.size);
  await client.fetchQuery(commentAuthorOptions('other-viewer', rows[0].user_id, send));
  assert.equal(requests.length, distinct.size + 1);
  client.clear();
});
