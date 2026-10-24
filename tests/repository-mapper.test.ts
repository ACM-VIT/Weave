import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeedRepositoryPayload } from '../src/api/feed';
import { mapFeedRepository } from '../src/utils/feed-repository';
import {
  mapPinnedRepository,
  mapRepositoryDetail,
  mapRepositoryList,
} from '../src/utils/repository-mapper';

const repositoryId = '10000000-0000-4000-8000-000000000001';

test('canonical mapper retains viewer-aware detail fields and numeric metadata', () => {
  const repository = mapRepositoryDetail({
    repo_id: repositoryId,
    github_id: 123456,
    full_name: 'ACM-VIT/weave',
    owner: 'ACM-VIT',
    owner_github_id: 42,
    name: 'weave',
    url: 'https://github.com/ACM-VIT/weave',
    status: 'active',
    description: 'Repository discovery inside Weave.',
    summary_id: 'summary-1',
    summary: 'A concise, active repository summary.',
    summary_model_version: 'summary-v2',
    summary_prompt_version: 'repo-card-summary-v2',
    summary_format_version: 'repo-card-summary.v2',
    summary_source: 'generated',
    summary_highlights: ['Personalized discovery', 'List-based saving'],
    readme_md: '# Weave\n\nComplete README content.',
    readme_source_path: 'docs/README.md',
    readme_default_branch: 'main',
    readme_base_url: 'https://raw.githubusercontent.com/ACM-VIT/weave/refs/heads/main/docs/',
    primary_language: 'TypeScript',
    languages: ['TypeScript', { name: 'Swift' }, 'TypeScript'],
    topics: [{ slug: 'open-source' }, 'social'],
    star_count: '12',
    fork_count: 3,
    open_issues_count: 1,
    likes_count: 7,
    dislikes_count: 2,
    saves_count: 4,
    comments_count: 5,
    views_count: 30,
    content_version: '9',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
    content_updated_at: '2026-08-03T00:00:00.000Z',
    source_updated_at: '2026-08-04T00:00:00.000Z',
    stats_observed_at: '2026-08-05T00:00:00.000Z',
    viewer_reaction: 'like',
    viewer_saved: true,
    selected_list_ids: ['list-1', 'list-2'],
    owner_user_id: 'user-1',
    owner_username: 'acm-vit',
    owner_display_name: 'ACM VIT',
    owner_avatar_url: 'https://avatars.example/acm-vit.png',
    owner_bio: 'Open-source builders.',
    owner_profile_id: 'profile-1',
    owner_profile_kind: 'organization',
    owner_profile_claimed_user_id: 'user-1',
    viewer_follows_owner: true,
  });

  assert.ok(repository);
  assert.equal(repository.id, repositoryId);
  assert.equal(repository.githubId, '123456');
  assert.equal(repository.ownerGithubId, '42');
  assert.equal(repository.fullName, 'ACM-VIT/weave');
  assert.equal(repository.status, 'active');
  assert.equal(repository.readmeSummary, 'A concise, active repository summary.');
  assert.equal(repository.readmeFull, '# Weave\n\nComplete README content.');
  assert.equal(repository.readmeSourcePath, 'docs/README.md');
  assert.equal(repository.readmeDefaultBranch, 'main');
  assert.equal(
    repository.readmeBaseUrl,
    'https://raw.githubusercontent.com/ACM-VIT/weave/refs/heads/main/docs/',
  );
  assert.deepEqual(repository.summaryHighlights, ['Personalized discovery', 'List-based saving']);
  assert.equal(repository.summaryPromptVersion, 'repo-card-summary-v2');
  assert.equal(repository.summaryFormatVersion, 'repo-card-summary.v2');
  assert.equal(repository.summarySource, 'generated');
  assert.deepEqual(repository.languages, ['TypeScript', 'Swift']);
  assert.deepEqual(repository.topics, ['open-source', 'social']);
  assert.deepEqual(repository.stats, {
    stars: 12,
    forks: 3,
    openIssues: 1,
    likes: 7,
    dislikes: 2,
    saves: 4,
    comments: 5,
    views: 30,
  });
  assert.equal(repository.contentVersion, 9);
  assert.equal(repository.summaryModelVersion, 'summary-v2');
  assert.equal(repository.observedAt, '2026-08-05T00:00:00.000Z');
  assert.deepEqual(repository.selectedListIds, ['list-1', 'list-2']);
  assert.equal(repository.ownerDisplayName, 'ACM VIT');
});

test('legacy list aliases map into the same contract without borrowing README content', () => {
  const longReadme = `# Complete README\n\n${'Implementation details. '.repeat(200)}`;
  const [repository] = mapRepositoryList([{
    repo_id: repositoryId,
    github_repo: 'acm-vit/weave',
    github_repo_url: 'https://github.com/acm-vit/weave',
    description: 'No summary available.',
    readme_summary: 'Summary unavailable',
    readme: longReadme,
    language_used: { TypeScript: 90, Swift: 10 },
    forks_count: 4,
    pr_count: 2,
    saved: true,
    selected_collection_ids: ['list-legacy'],
  }]);

  assert.ok(repository);
  assert.equal(repository.owner, 'acm-vit');
  assert.equal(repository.name, 'weave');
  assert.equal(repository.description, '');
  assert.equal(repository.readmeSummary, null);
  assert.equal(repository.readmeFull, longReadme.trim());
  assert.deepEqual(repository.languages, ['TypeScript', 'Swift']);
  assert.equal(repository.stats.forks, 4);
  assert.equal(repository.stats.openIssues, 2);
  assert.equal(repository.viewerSaved, true);
  assert.deepEqual(repository.selectedListIds, ['list-legacy']);
});

test('feed uses the same mapper contract as canonical repository detail', () => {
  const feedPayload: FeedRepositoryPayload = {
    repo_id: repositoryId,
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
  };

  assert.deepEqual(mapFeedRepository(feedPayload), mapRepositoryDetail(feedPayload));
});

test('pinned mapping preserves the canonical repository UUID, not the storage key', () => {
  const repository = mapPinnedRepository({
    key: 'local-storage-key',
    repositoryId,
    name: 'weave',
    owner: 'acm-vit',
    description: 'Repository discovery.',
    primaryLanguage: 'TypeScript',
    url: 'https://github.com/acm-vit/weave',
    pinnedAt: '2026-08-09T00:00:00.000Z',
  });

  assert.ok(repository);
  assert.equal(repository.id, repositoryId);
  assert.notEqual(repository.id, 'local-storage-key');
});

test('current detail Lists exclude hidden board memberships without changing saved truth', () => {
  const repository = mapRepositoryDetail({repo_id: repositoryId, full_name: 'owner/repo', viewer_saved: true,
    selected_list_ids: ['collection:current', 'legacy-board:hidden']});
  assert.equal(repository.viewerSaved, true);
  assert.deepEqual(repository.selectedListIds, ['collection:current']);
});
