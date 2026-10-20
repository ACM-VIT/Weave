import assert from 'node:assert/strict';
import test from 'node:test';

import type { RepositoryUpsert } from '../../contracts/ingestion.v2.js';
import {
  buildMlRepositoryFeaturePatch,
  buildMlRepositorySource,
  repositoryContentHash,
} from '../../services/mlRepositoryPayloadService.js';

const ingestionRecord: RepositoryUpsert = {
  github_id: '123456789',
  github_node_id: 'R_backend_only',
  owner_github_id: '987654321',
  full_name: 'weave/repository',
  owner: 'weave',
  name: 'repository',
  url: 'https://github.com/weave/repository',
  description: null,
  readme: '# Weave\n\n![Preview](./assets/preview.png)\n',
  readme_source_path: 'docs/README.md',
  readme_default_branch: 'main',
  readme_base_url: 'https://raw.githubusercontent.com/weave/repository/refs/heads/main/docs/',
  readme_length: 250,
  primary_language: null,
  languages: ['TypeScript'],
  topics: ['recommendations'],
  star_count: 42,
  fork_count: 7,
  open_issues_count: 3,
  pushed_days_ago: 2,
  delta_3d: 4,
  delta_7d: -1,
  delta_30d: 12,
  mentionable_users_count: 5,
  readme_to_codebase_ratio: 0.25,
  recent_commits: ['2026-07-20T13:30:00+05:30'],
  created_at: '2025-01-01T05:30:00+05:30',
  updated_at: '2026-07-21T07:30:00+05:30',
  pushed_at: '2026-07-21T08:30:00+05:30',
  discovery_category: ' trending ',
  discovery_band: ' daily ',
  observed_at: '2026-07-21T09:00:00.000Z',
};

test('repository-index projection emits only the strict ML v2 source keys', () => {
  const projected = buildMlRepositorySource(ingestionRecord, 'content-sha256');

  assert.deepEqual(Object.keys(projected).sort(), [
    'content_hash',
    'created_at',
    'delta_30d',
    'delta_3d',
    'delta_7d',
    'description',
    'discovery_band',
    'discovery_category',
    'fork_count',
    'full_name',
    'github_id',
    'languages',
    'mentionable_users_count',
    'open_issues_count',
    'primary_language',
    'pushed_at',
    'pushed_days_ago',
    'readme',
    'readme_base_url',
    'readme_default_branch',
    'readme_length',
    'readme_source_path',
    'readme_to_codebase_ratio',
    'recent_commits',
    'star_count',
    'topics',
    'updated_at',
    'url',
  ]);
  assert.equal(projected.description, '');
  assert.equal(projected.primary_language, 'Unknown');
  assert.equal(projected.pushed_at, '2026-07-21T03:00:00.000Z');
  assert.equal(projected.created_at, '2025-01-01T00:00:00.000Z');
  assert.equal(projected.updated_at, '2026-07-21T02:00:00.000Z');
  assert.deepEqual(projected.recent_commits, ['2026-07-20T08:00:00.000Z']);
  assert.equal(projected.discovery_category, 'trending');
  assert.equal(projected.discovery_band, 'daily');
  assert.equal(projected.readme, ingestionRecord.readme);
  assert.equal(projected.readme_source_path, 'docs/README.md');
  assert.equal(projected.readme_default_branch, 'main');
  assert.equal(projected.readme_base_url, 'https://raw.githubusercontent.com/weave/repository/refs/heads/main/docs/');
  assert.equal(Object.hasOwn(projected, 'github_node_id'), false);
  assert.equal(Object.hasOwn(projected, 'owner_github_id'), false);
  assert.equal(Object.hasOwn(projected, 'owner'), false);
  assert.equal(Object.hasOwn(projected, 'name'), false);
  assert.equal(Object.hasOwn(projected, 'observed_at'), false);
  assert.equal(Object.hasOwn(projected, 'repo_id'), false);
});

test('repository-refresh projection uses observed ML fields and never fabricates trending keys', () => {
  const projected = buildMlRepositoryFeaturePatch(ingestionRecord);

  assert.deepEqual(Object.keys(projected).sort(), [
    'delta_30d', 'delta_3d', 'delta_7d', 'discovery_band', 'discovery_category',
    'fork_count', 'mentionable_users_count', 'open_issues_count', 'pushed_at',
    'pushed_days_ago', 'star_count', 'updated_at',
  ]);
  assert.deepEqual(projected, {
    star_count: 42,
    fork_count: 7,
    open_issues_count: 3,
    pushed_days_ago: 2,
    delta_3d: 4,
    delta_7d: -1,
    delta_30d: 12,
    mentionable_users_count: 5,
    updated_at: '2026-07-21T02:00:00.000Z',
    pushed_at: '2026-07-21T03:00:00.000Z',
    discovery_category: 'trending',
    discovery_band: 'daily',
  });
  assert.equal(Object.hasOwn(projected, 'trending_rank'), false);
  assert.equal(Object.hasOwn(projected, 'trending_score'), false);
});

test('empty and null README publishers share one canonical content identity', () => {
  const absent = {
    ...ingestionRecord,
    readme: null,
    readme_source_path: null,
    readme_default_branch: null,
    readme_base_url: null,
    readme_length: 0,
    readme_to_codebase_ratio: 0,
    recent_commits: [],
  };
  const emptyPublisher = {
    ...ingestionRecord,
    readme: '',
    readme_source_path: 'README.md',
    readme_default_branch: 'main',
    readme_base_url: 'https://raw.githubusercontent.com/weave/repository/refs/heads/main/',
    readme_length: 0,
    readme_to_codebase_ratio: 0,
    recent_commits: [],
  };
  const projected = buildMlRepositorySource(emptyPublisher, 'content-sha256');
  assert.equal(projected.readme, null);
  assert.equal(projected.readme_source_path, null);
  assert.equal(projected.readme_default_branch, null);
  assert.equal(projected.readme_base_url, null);
  assert.equal(projected.readme_length, 0);
  assert.equal(repositoryContentHash(emptyPublisher), repositoryContentHash(absent));
});

test('index-only activity fields trigger delivery even when repository prose is unchanged', () => {
  for (const update of [
    { recent_commits: ['2026-10-20T00:00:00Z'] },
    { readme_to_codebase_ratio: 0.5 },
  ]) {
    const updated = { ...ingestionRecord, ...update };
    assert.notEqual(repositoryContentHash(updated), repositoryContentHash(ingestionRecord));
    const indexed = buildMlRepositorySource(updated, repositoryContentHash(updated));
    assert.equal(indexed.readme_to_codebase_ratio, updated.readme_to_codebase_ratio);
    assert.deepEqual(indexed.recent_commits, updated.recent_commits?.map((value) => new Date(value).toISOString()));
  }
});
