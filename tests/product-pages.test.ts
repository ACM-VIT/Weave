import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { requestKeysetItems } from '../src/api/keyset-pagination';
import { requestProfileRepositoryPage } from '../src/api/profile-repository-pages';
import { requestCommentsKeysetPage } from '../src/api/comments-data';
import { profileRepositoryInvalidationFilters, profileRepositoryQuery } from '../src/api/profile-section-queries';

test('profile requests preserve opaque deep cursors and server continuation on a short page', async () => {
  const cursor = 'after-10000/+?opaque';
  const page = await requestProfileRepositoryPage('likes', 'viewer/id', cursor, async path => {
    const url = new URL(path, 'http://fixture.invalid');
    assert.equal(url.pathname, '/users/viewer%2Fid/likes-given');
    assert.equal(url.searchParams.get('pagination'), 'keyset');
    assert.equal(url.searchParams.get('cursor'), cursor);
    assert.equal(url.searchParams.get('offset'), null);
    assert.equal(url.searchParams.get('limit'), '40');
    return { items: [{repo_id:'one',full_name:'fixture/one'}], has_more:true, next_cursor:'next-opaque' };
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, 'next-opaque');
});

test('a full final page ends without requesting an extra empty offset page', async () => {
  const page = await requestProfileRepositoryPage('saved', 'viewer', null, async () => ({
    items: Array.from({length:40}, (_,i) => ({repo_id:String(i),full_name:`fixture/repo${i}`})),
    has_more:false, next_cursor:null,
  }));
  assert.equal(page.items.length, 40);
  assert.equal(page.nextCursor, undefined);
});

test('older-server responses fail closed instead of silently truncating saved history', async () => {
  await assert.rejects(requestProfileRepositoryPage('saved', 'viewer', null, async () => ({items:[]})), /pagination response/);
  await assert.rejects(requestKeysetItems('/users/viewer/following', {}, async () => ({items:[],limit:25,offset:0})), /pagination response/);
});

test('comments preserve server continuation when normalization removes malformed rows', async () => {
  const page = await requestCommentsKeysetPage('repo', 'opaque-start', async path => {
    assert.ok(path.includes('pagination=keyset'));
    assert.ok(path.includes('cursor=opaque-start'));
    return { items:[{}], has_more:true, next_cursor:'opaque-next' };
  });
  assert.deepEqual(page.items, []);
  assert.equal(page.next_cursor, 'opaque-next');
});

test('save invalidation reaches the cursor cache and preserves other viewers and likes', async () => {
  const client = new QueryClient();
  const own = profileRepositoryQuery('alice', 'saved', false, async () => ({items:[]})).queryKey;
  const other = profileRepositoryQuery('bob', 'saved', false, async () => ({items:[]})).queryKey;
  const likes = profileRepositoryQuery('alice', 'likes', false, async () => ({items:[]})).queryKey;
  for (const key of [own,other,likes]) client.setQueryData(key, {pages:[{items:[]}],pageParams:[null]});
  await client.invalidateQueries(profileRepositoryInvalidationFilters('alice', 'saved'));
  assert.equal(client.getQueryState(own)?.isInvalidated, true);
  assert.equal(client.getQueryState(other)?.isInvalidated, false);
  assert.equal(client.getQueryState(likes)?.isInvalidated, false);
  client.clear();
});
