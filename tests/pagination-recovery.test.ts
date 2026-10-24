import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { requestKeysetItems } from "../src/api/keyset-pagination";
import { requestProfileRepositoryPage } from "../src/api/profile-repository-pages";
import { requestCommentsKeysetPage } from "../src/api/comments-data";
import { profileRepositoryInvalidationFilters, profileRepositoryQuery } from "../src/api/profile-section-queries";
import { buildFollowMutation, collectConnectionIds, connectionFollowState, connectionIdentity, getNextConnectionOffset, mergeConnectionPages, type ConnectionPage } from "../src/utils/connection-pagination";
import { retryKeysetQuery } from "../src/services/keysetQueryRecovery";

describe("product pages", () => {
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
});

describe("connection pagination", () => {
  type Person = { user_id: string; username: string };

  function page(items: Person[], limit: number, offset: number): ConnectionPage<Person> {
    return { items, limit, offset };
  }

  test('connection pagination advances full pages and stops on a partial page or offset limit', () => {
    const fullPage = page([
      { user_id: 'a', username: 'ada' },
      { user_id: 'b', username: 'bea' },
    ], 2, 0);
    assert.equal(getNextConnectionOffset(fullPage), 2);
    assert.equal(getNextConnectionOffset(page(fullPage.items.slice(0, 1), 2, 2)), undefined);
    assert.equal(getNextConnectionOffset(page(fullPage.items, 2, 10_000)), undefined);
  });

  test('follow controls use the idempotent v2 PUT and DELETE contract', () => {
    assert.deepEqual(buildFollowMutation('user/id', false), {
      path: '/users/user%2Fid/follow',
      method: 'PUT',
      nextFollowing: true,
    });
    assert.deepEqual(buildFollowMutation('user/id', true), {
      path: '/users/user%2Fid/follow',
      method: 'DELETE',
      nextFollowing: false,
    });
    assert.throws(() => buildFollowMutation('', false), /user id is required/i);
  });

  test('connection pages are merged in server order without duplicate people', () => {
    const ada = { user_id: 'a', username: 'ada' };
    const bea = { user_id: 'b', username: 'bea' };
    const cy = { user_id: 'c', username: 'cy' };

    assert.deepEqual(
      mergeConnectionPages([page([ada, bea], 2, 0), page([bea, cy], 2, 2)]),
      [ada, bea, cy],
    );
  });

  test('connection identity keeps external profiles separate from app users', () => {
    assert.equal(connectionIdentity({ user_id: 'same-id' }), 'user:same-id');
    assert.equal(connectionIdentity({ profile_id: 'same-id' }), 'profile:same-id');
    assert.deepEqual(
      mergeConnectionPages([
        {
          items: [
            { user_id: 'same-id', username: 'app-user' },
            { profile_id: 'same-id', username: 'github-owner' },
          ],
          limit: 25,
          offset: 0,
        },
      ]),
      [
        { user_id: 'same-id', username: 'app-user' },
        { profile_id: 'same-id', username: 'github-owner' },
      ],
    );
  });

  test('connection follow state uses the matching registered or external profile field', () => {
    assert.deepEqual(
      connectionFollowState({
        user_id: 'user-id',
        viewer_follows_user: false,
        viewer_follows_profile: true,
      }, false),
      { following: false, stateKnown: true },
    );
    assert.deepEqual(
      connectionFollowState({
        profile_id: 'profile-id',
        viewer_follows_user: false,
        viewer_follows_profile: true,
      }, false),
      { following: true, stateKnown: true },
    );
  });

  test('the viewers own following list is authoritative for external profile rows', () => {
    assert.deepEqual(
      connectionFollowState({ profile_id: 'profile-id' }, true),
      { following: true, stateKnown: true },
    );
    assert.deepEqual(
      connectionFollowState({ profile_id: 'profile-id' }, true, false),
      { following: false, stateKnown: true },
    );
  });

  test('following lookup consumes every page and de-duplicates relationship ids', async () => {
    const requestedOffsets: number[] = [];
    const pages = new Map<number, ConnectionPage<Person>>([
      [0, page([{ user_id: 'a', username: 'ada' }, { user_id: 'b', username: 'bea' }], 2, 0)],
      [2, page([{ user_id: 'b', username: 'bea' }, { user_id: 'c', username: 'cy' }], 2, 2)],
      [4, page([{ user_id: 'd', username: 'dee' }], 2, 4)],
    ]);

    const ids = await collectConnectionIds(async (offset) => {
      requestedOffsets.push(offset);
      const result = pages.get(offset);
      if (!result) throw new Error(`Unexpected offset ${offset}`);
      return result;
    }, 2);

    assert.deepEqual(requestedOffsets, [0, 2, 4]);
    assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
  });

  test('following lookup never requests an offset beyond the backend contract', async () => {
    const requestedOffsets: number[] = [];
    await collectConnectionIds(async (offset, limit) => {
      requestedOffsets.push(offset);
      return page(Array.from({ length: limit }, (_, index) => ({
        user_id: `${offset + index}`,
        username: `user-${offset + index}`,
      })), limit, offset);
    }, 2, 4);

    assert.deepEqual(requestedOffsets, [0, 2, 4]);
  });
});

describe("keyset query recovery", () => {
  for (const [status, nextPageError, expected] of [[400, true, 'refetch'], [503, true, 'next'], [undefined, true, 'next'], [400, false, 'refetch']] as const) {
    test(`keyset recovery status=${status}, next-page=${nextPageError}`, async () => {
      const calls: string[] = [];
      await retryKeysetQuery({
        error: Object.assign(new Error('fixture'), { status }), isFetchNextPageError: nextPageError,
        fetchNextPage: async options => { assert.equal(options.cancelRefetch, false); calls.push('next'); },
        refetch: async options => { assert.equal(options.cancelRefetch, false); calls.push('refetch'); },
      });
      assert.deepEqual(calls, [expected]);
    });
  }
});
