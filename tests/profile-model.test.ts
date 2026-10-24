import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { type RepositoryDetail } from "../src/models/repository";
import { applyProfileLikeOverrides, optimisticLikeDelta, patchProfileLikeOverrides, settleProfileLikeOverrides } from "../src/utils/profile-likes";
import { mergeSavedUserProfile } from "../src/utils/profile-state";
import { followStateQueryKey, getFollowIdentity, getProfileFollowIdentity } from "../src/utils/follow-state";

describe("profile likes", () => {
  function repository(id: string, viewerReaction: RepositoryDetail['viewerReaction'] = null): RepositoryDetail {
    return {
      id,
      githubId: null,
      fullName: `owner/${id}`,
      name: id,
      owner: 'owner',
      githubUrl: `https://github.com/owner/${id}`,
      status: 'active',
      description: '',
      summaryId: null,
      readmeSummary: null,
      readmeFull: null,
      readmeSourcePath: null,
      readmeDefaultBranch: null,
      readmeBaseUrl: null,
      summaryHighlights: [],
      summaryPromptVersion: null,
      summaryFormatVersion: null,
      summarySource: null,
      languages: [],
      topics: [],
      primaryLanguage: null,
      stats: { stars: 0, forks: 0, openIssues: 0, likes: 4, dislikes: 0, saves: 0, comments: 0, views: 0 },
      createdAt: null,
      updatedAt: null,
      observedAt: null,
      contentUpdatedAt: null,
      sourceUpdatedAt: null,
      contentVersion: null,
      summaryModelVersion: null,
      viewerReaction,
      viewerSaved: false,
      selectedListIds: [],
      ownerGithubId: null,
      ownerUserId: null,
      ownerUsername: null,
      ownerDisplayName: null,
      ownerAvatarUrl: null,
      ownerBio: null,
      ownerProfileId: null,
      ownerProfileKind: null,
      ownerProfileClaimedUserId: null,
      viewerFollowsOwner: null,
      serveId: null,
      feedPosition: null,
    };
  }

  test('a new like appears at the top of Likes Given immediately', () => {
    const existing = repository('existing', 'like');
    const newlyLiked = repository('new');
    const overrides = patchProfileLikeOverrides(undefined, newlyLiked, 'like', 'event-new');
    const result = applyProfileLikeOverrides([existing], overrides);

    assert.deepEqual(result.map((item) => item.id), ['new', 'existing']);
    assert.equal(result[0].viewerReaction, 'like');
    assert.equal(result[0].stats.likes, 5);
    assert.equal(optimisticLikeDelta(false, 'like'), 1);
  });

  test('unlike and dislike remove an existing like without waiting for a refetch', () => {
    const liked = repository('liked', 'like');

    for (const action of ['unlike', 'dislike'] as const) {
      const overrides = patchProfileLikeOverrides(undefined, liked, action);
      assert.deepEqual(applyProfileLikeOverrides([liked], overrides), []);
      assert.equal(optimisticLikeDelta(true, action), -1);
    }
  });

  test('rapid like then unlike restores the original count immediately', () => {
    const repositoryToToggle = repository('rapid');
    const liked = patchProfileLikeOverrides(undefined, repositoryToToggle, 'like');
    assert.equal(optimisticLikeDelta(liked?.rapid.liked ?? false, 'unlike'), -1);

    const unliked = patchProfileLikeOverrides(liked, repositoryToToggle, 'unlike');
    assert.deepEqual(applyProfileLikeOverrides([], unliked), []);
  });

  test('unrelated activity leaves profile like overrides untouched', () => {
    const current = patchProfileLikeOverrides(undefined, repository('liked'), 'like');
    assert.equal(patchProfileLikeOverrides(current, repository('other'), 'share'), current);
  });

  test('multiple optimistic likes stay newest-first, including a relike', () => {
    const first = repository('first');
    const second = repository('second');
    let overrides = patchProfileLikeOverrides(undefined, first, 'like');
    overrides = patchProfileLikeOverrides(overrides, second, 'like');
    assert.deepEqual(applyProfileLikeOverrides([], overrides).map((item) => item.id), ['second', 'first']);

    overrides = patchProfileLikeOverrides(overrides, first, 'like');
    assert.deepEqual(applyProfileLikeOverrides([], overrides).map((item) => item.id), ['first', 'second']);
  });

  test('acknowledgements remove only the optimistic state they confirm', () => {
    const target = repository('target');
    const liked = patchProfileLikeOverrides(undefined, target, 'like', 'event-like');
    const unliked = patchProfileLikeOverrides(liked, target, 'unlike', 'event-unlike');

    const afterOldLike = settleProfileLikeOverrides(unliked, [{ event_id: 'event-like', repo_id: 'target', action: 'like' }]);
    assert.equal(afterOldLike?.target.liked, false);
    assert.deepEqual(
      settleProfileLikeOverrides(afterOldLike, [{ event_id: 'event-unlike', repo_id: 'target', action: 'unlike' }]),
      {},
    );
  });

  test('an older acknowledgement cannot clear a newer pending override', () => {
    const target = repository('target');
    const first = patchProfileLikeOverrides(undefined, target, 'like', 'event-1');
    const newer = patchProfileLikeOverrides(first, target, 'unlike', 'event-2');
    const stillPending = settleProfileLikeOverrides(newer, [{ event_id: 'event-1', repo_id: 'target', action: 'like' }]);
    assert.equal(stillPending?.target.eventId, 'event-2');
  });
});

describe("profile state", () => {
  test('a saved profile replaces editable attributes without losing authenticated user state', () => {
    const current = {
      user_id: 'user-1',
      username: 'old-name',
      full_name: 'Old Name',
      bio: 'Old bio',
      followers_count: 4,
      onboarding_completed: true,
    };

    assert.deepEqual(
      mergeSavedUserProfile(current, {
        username: 'new-name',
        full_name: 'New Name',
        bio: 'New bio',
      }),
      {
        user_id: 'user-1',
        username: 'new-name',
        full_name: 'New Name',
        bio: 'New bio',
        followers_count: 4,
        onboarding_completed: true,
      },
    );
  });

  test('a late profile response cannot recreate a signed-out user', () => {
    assert.equal(
      mergeSavedUserProfile(null, {
        username: 'new-name',
        full_name: 'New Name',
        bio: 'New bio',
      }),
      null,
    );
  });
});

describe("follow state", () => {
  test('follow state prefers the stable user id across screens', () => {
    const identity = getFollowIdentity(' user-123 ', 'DifferentUsername');

    assert.equal(identity, 'user-123');
    assert.deepEqual(followStateQueryKey(identity), ['user-follow-state', null, 'user-123']);
  });

  test('follow state normalizes username fallbacks when no user id is available', () => {
    assert.equal(getFollowIdentity(null, ' Navyaa '), 'navyaa');
    assert.equal(getFollowIdentity(undefined, '@Navyaa'), '@navyaa');
  });

  test('external profile follow state is namespaced separately from app users', () => {
    assert.equal(
      getProfileFollowIdentity(' profile-123 ', 'user-123', 'owner'),
      'profile:profile-123',
    );
    assert.equal(
      getProfileFollowIdentity(null, ' user-123 ', 'owner'),
      'user-123',
    );
  });

  test('follow cache is isolated by viewer', () => {
    assert.notDeepEqual(followStateQueryKey('target', 'alice'), followStateQueryKey('target', 'bob'));
  });
});
