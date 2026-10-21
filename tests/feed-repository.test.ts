import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeedRepositoryPayload } from '../src/api/feed';
import {
  getFeedItemIdentity,
  mapFeedRepository,
  patchFeedReaction,
  patchFeedSaved,
  reconcileFeedItemSavedState,
} from '../src/utils/feed-repository';
import { prepareReadmePreview, README_SUMMARY_PENDING } from '../src/utils/readme';

function feedRepository(
  overrides: Partial<FeedRepositoryPayload> = {},
): FeedRepositoryPayload {
  return {
    repo_id: '10000000-0000-4000-8000-000000000001',
    full_name: 'acm-vit/weave',
    owner_user_id: null,
    owner_profile_id: null,
    owner_profile_claimed_user_id: null,
    owner_bio: null,
    description: 'A social repository discovery app.',
    languages: ['TypeScript'],
    star_count: 12,
    fork_count: 3,
    likes_count: 4,
    comments_count: 2,
    views_count: 20,
    open_issues_count: 1,
    summary: 'A concise active card summary.',
    readme_md: '# Weave\n\nThe complete document.',
    updated_at: '2026-08-01T00:00:00.000Z',
    viewer_reaction: null,
    viewer_saved: false,
    viewer_follows_owner: false,
    position: 7,
    serve_id: '20000000-0000-4000-8000-000000000001',
    feed_version: '4',
    ...overrides,
  };
}

test('feed mapping keeps the active summary and complete README in separate nullable fields', () => {
  const mapped = mapFeedRepository(feedRepository({
    summary: '  Active summary  ',
    readme_summary: 'Legacy summary',
    readme_md: '  # Full README\n\nComplete content.  ',
  }));

  assert.ok(mapped);
  assert.equal(mapped.readmeSummary, 'Active summary');
  assert.equal(mapped.readmeFull, '# Full README\n\nComplete content.');
});

test('legacy placeholders map to missing content without borrowing from a long README', () => {
  const longReadme = `# Full project documentation\n\n${'Implementation detail. '.repeat(300)}`;
  const mapped = mapFeedRepository(feedRepository({
    summary: 'No summary available.',
    readme_summary: 'Summary unavailable',
    readme_md: longReadme,
  }));

  assert.ok(mapped);
  assert.equal(mapped.readmeSummary, null);
  assert.equal(mapped.readmeFull, longReadme.trim());
  const preview = prepareReadmePreview({
    summary: mapped.readmeSummary,
    description: mapped.description,
    fullReadme: mapped.readmeFull,
  });
  assert.equal(preview.source, 'pending');
  assert.equal(preview.markdown, README_SUMMARY_PENDING);
  assert.equal(preview.markdown.includes('Implementation detail'), false);
});

test('mapped README-equivalent summaries resolve to the exact pending state', () => {
  const fullReadme = '# Complete README\n\nInstall, configure, and run the project.';
  const mapped = mapFeedRepository(feedRepository({
    summary: 'COMPLETE README install configure and run the project',
    description: 'No summary available.',
    readme_md: fullReadme,
  }));

  assert.ok(mapped);
  assert.deepEqual(prepareReadmePreview({
    summary: mapped.readmeSummary,
    description: mapped.description,
    fullReadme: mapped.readmeFull,
  }), {
    isTruncated: false,
    markdown: README_SUMMARY_PENDING,
    source: 'pending',
  });
});

test('feed item identity is stable across optimistic reaction and save state changes', () => {
  const repository = mapFeedRepository(feedRepository());
  assert.ok(repository);
  const initialIdentity = getFeedItemIdentity(repository, 0);

  assert.equal(
    getFeedItemIdentity(
      { ...repository, viewerReaction: 'like', viewerSaved: true },
      0,
    ),
    initialIdentity,
  );
  assert.equal(
    initialIdentity,
    `${repository.serveId}:${repository.id}:${repository.feedPosition}`,
  );
});

test('optimistic reaction patches only the matching served position and maintains likes', () => {
  const target = feedRepository();
  const other = feedRepository({
    repo_id: '10000000-0000-4000-8000-000000000002',
    position: 8,
  });
  const cache = {
    pages: [{ items: [target, other], nextCursor: 'next' }],
    pageParams: [null],
  };
  const identity = {
    repoId: target.repo_id,
    serveId: target.serve_id,
    position: target.position,
  };

  const liked = patchFeedReaction(cache, identity, 'like');
  assert.notEqual(liked, cache);
  assert.equal(liked?.pages[0].items[0].viewer_reaction, 'like');
  assert.equal(liked?.pages[0].items[0].likes_count, 5);
  assert.equal(liked?.pages[0].items[1], other);

  const disliked = patchFeedReaction(liked, identity, 'dislike');
  assert.equal(disliked?.pages[0].items[0].viewer_reaction, 'dislike');
  assert.equal(disliked?.pages[0].items[0].likes_count, 4);

  const mismatchedUnlike = patchFeedReaction(disliked, identity, 'unlike');
  assert.equal(mismatchedUnlike, disliked);
  assert.equal(mismatchedUnlike?.pages[0].items[0].viewer_reaction, 'dislike');

  const undisliked = patchFeedReaction(disliked, identity, 'undislike');
  assert.equal(undisliked?.pages[0].items[0].viewer_reaction, null);
  assert.equal(undisliked?.pages[0].items[0].likes_count, 4);

  const reliked = patchFeedReaction(undisliked, identity, 'like');
  const mismatchedUndislike = patchFeedReaction(reliked, identity, 'undislike');
  assert.equal(mismatchedUndislike, reliked);
  assert.equal(mismatchedUndislike?.pages[0].items[0].viewer_reaction, 'like');

  const unliked = patchFeedReaction(reliked, identity, 'unlike');
  assert.equal(unliked?.pages[0].items[0].viewer_reaction, null);
  assert.equal(unliked?.pages[0].items[0].likes_count, 4);
});

test('saved state patches in place without changing the served item identity', () => {
  const target = feedRepository();
  const cache = {
    pages: [{ items: [target], nextCursor: null }],
    pageParams: [null],
  };
  const saved = patchFeedSaved(cache, {
    repoId: target.repo_id,
    serveId: target.serve_id,
    position: target.position,
  }, true);

  assert.equal(saved?.pages[0].items[0].viewer_saved, true);
  assert.equal(saved?.pages[0].items[0].repo_id, target.repo_id);
  assert.equal(saved?.pages[0].items[0].serve_id, target.serve_id);
  assert.equal(saved?.pages[0].items[0].position, target.position);
});

test('feed item local saved state follows changes from the same repository cache entry', () => {
  const repositoryId = '10000000-0000-4000-8000-000000000001';
  const optimistic = {
    repositoryId,
    serverSaved: false,
    saved: true,
  };

  const acknowledged = reconcileFeedItemSavedState(optimistic, repositoryId, true);
  assert.deepEqual(acknowledged, {
    repositoryId,
    serverSaved: true,
    saved: true,
  });

  const externallyRemoved = reconcileFeedItemSavedState(acknowledged, repositoryId, false);
  assert.deepEqual(externallyRemoved, {
    repositoryId,
    serverSaved: false,
    saved: false,
  });
});

test('feed displays the exact backend engagement count instead of sample or star counts', () => {
  for (const likes of [0, 1, 27, 9842]) {
    const repository = mapFeedRepository(feedRepository({ likes_count: likes, star_count: 654321 }));
    assert.ok(repository);
    assert.equal(repository.stats.likes, likes);
    assert.equal(repository.stats.stars, 654321);
  }
});
