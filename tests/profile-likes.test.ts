import assert from 'node:assert/strict';
import test from 'node:test';

import type { RepositoryDetail } from '../src/models/repository';
import {
  applyProfileLikeOverrides,
  optimisticLikeDelta,
  patchProfileLikeOverrides,
} from '../src/utils/profile-likes';

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
  const overrides = patchProfileLikeOverrides(undefined, newlyLiked, 'like');
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
