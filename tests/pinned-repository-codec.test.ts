import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PINNED_DESCRIPTION_LENGTH,
  parsePinnedRepositories,
  serializePinnedRepositories,
  type PinnedRepository,
} from '../src/services/pinnedRepositoryCodec';

const repository: PinnedRepository = {
  key: 'repo-id:openai/example',
  repositoryId: 'repo-id',
  name: 'example',
  owner: 'openai',
  description: 'A useful repository.',
  primaryLanguage: 'TypeScript',
  url: 'https://github.com/openai/example',
  pinnedAt: '2026-07-22T12:00:00.000Z',
};

test('pinned repository payloads round-trip with their storage version', () => {
  assert.deepEqual(
    parsePinnedRepositories(serializePinnedRepositories([repository])),
    [repository],
  );
});

test('pinned repository parsing fails safely and keeps only valid unique records', () => {
  assert.deepEqual(parsePinnedRepositories('{not-json'), []);
  assert.deepEqual(parsePinnedRepositories(JSON.stringify({ version: 2, repositories: [repository] })), []);

  const parsed = parsePinnedRepositories(JSON.stringify({
    version: 1,
    repositories: [
      { ...repository, description: 'x'.repeat(MAX_PINNED_DESCRIPTION_LENGTH + 20) },
      repository,
      { key: '', repositoryId: null },
    ],
  }));

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].description.length, MAX_PINNED_DESCRIPTION_LENGTH);
});
