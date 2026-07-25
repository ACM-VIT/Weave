import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFollowMutation,
  collectConnectionIds,
  connectionFollowState,
  connectionIdentity,
  getNextConnectionOffset,
  mergeConnectionPages,
  type ConnectionPage,
} from '../src/utils/connection-pagination';

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
