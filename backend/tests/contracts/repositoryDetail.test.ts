import assert from 'node:assert/strict';
import test from 'node:test';

import { mapRepositoryDetailRow } from '../../services/repositoryDetailService.js';

test('repository detail mapper keeps summary, README, viewer state, and Lists distinct', () => {
  const detail = mapRepositoryDetailRow({
    repo_id: '00000000-0000-4000-8000-000000000001',
    github_id: 42n,
    full_name: 'owner/repository',
    owner: 'owner',
    owner_github_id: 7n,
    name: 'repository',
    url: 'https://github.com/owner/repository',
    status: 'active',
    owner_user_id: '00000000-0000-4000-8000-000000000002',
    owner_profile_id: '00000000-0000-4000-8000-000000000003',
    owner_profile_claimed_user_id: '00000000-0000-4000-8000-000000000002',
    owner_username: 'owner-user',
    owner_display_name: 'Owner User',
    owner_avatar_url: 'https://example.com/avatar.png',
    owner_bio: 'Builds useful things.',
    owner_profile_kind: 'user',
    viewer_follows_owner: true,
    description: 'Short repository description.',
    summary_id: '00000000-0000-4000-8000-000000000004',
    summary: 'Generated concise summary.',
    summary_highlights: ['Internal navigation'],
    summary_prompt_version: 'repo-card-summary-v1',
    summary_model_version: 'summary-v2',
    summary_format_version: 'repo-card-summary-json-v1',
    summary_source: 'generated',
    readme_md: '# Complete README\n\nThis remains the full document.',
    readme_source_path: 'docs/README.md',
    readme_default_branch: 'main',
    readme_base_url: 'https://raw.githubusercontent.com/owner/repository/refs/heads/main/docs/',
    primary_language: 'TypeScript',
    languages: ['TypeScript', 'SQL'],
    topics: ['expo', 'react-native'],
    star_count: '10',
    fork_count: 2,
    open_issues_count: null,
    likes_count: 4,
    dislikes_count: 1,
    saves_count: 3,
    comments_count: 5,
    views_count: '99',
    content_version: 6,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: new Date('2026-08-02T00:00:00.000Z'),
    content_updated_at: '2026-08-02T00:00:00.000Z',
    source_updated_at: null,
    stats_observed_at: '2026-08-03T00:00:00.000Z',
    viewer_reaction: 'like',
    viewer_saved: true,
    selected_list_ids: [
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000006',
    ],
  });

  assert.equal(detail.github_id, '42');
  assert.equal(detail.owner_github_id, '7');
  assert.equal(detail.summary, 'Generated concise summary.');
  assert.equal(detail.readme_md, '# Complete README\n\nThis remains the full document.');
  assert.deepEqual(detail.summary_highlights, ['Internal navigation']);
  assert.equal(detail.summary_prompt_version, 'repo-card-summary-v1');
  assert.equal(detail.summary_format_version, 'repo-card-summary-json-v1');
  assert.equal(detail.summary_source, 'generated');
  assert.equal(detail.readme_source_path, 'docs/README.md');
  assert.equal(detail.readme_default_branch, 'main');
  assert.equal(detail.readme_base_url, 'https://raw.githubusercontent.com/owner/repository/refs/heads/main/docs/');
  assert.equal(detail.viewer_reaction, 'like');
  assert.equal(detail.viewer_saved, true);
  assert.deepEqual(detail.selected_list_ids, [
    '00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000006',
  ]);
  assert.equal(detail.star_count, 10);
  assert.equal(detail.open_issues_count, 0);
  assert.equal(detail.updated_at, '2026-08-02T00:00:00.000Z');
});

test('repository detail mapper normalizes absent viewer and optional content state', () => {
  const detail = mapRepositoryDetailRow({
    repo_id: '00000000-0000-4000-8000-000000000001',
    github_id: '42',
    full_name: 'owner/repository',
    owner: 'owner',
    owner_github_id: null,
    name: 'repository',
    url: 'https://github.com/owner/repository',
    status: 'active',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    viewer_reaction: 'unsupported',
    viewer_saved: false,
  });

  assert.equal(detail.summary, null);
  assert.equal(detail.readme_md, null);
  assert.deepEqual(detail.summary_highlights, []);
  assert.equal(detail.summary_source, null);
  assert.equal(detail.readme_base_url, null);
  assert.equal(detail.viewer_reaction, null);
  assert.equal(detail.viewer_saved, false);
  assert.deepEqual(detail.languages, []);
  assert.deepEqual(detail.topics, []);
  assert.deepEqual(detail.selected_list_ids, []);
});
