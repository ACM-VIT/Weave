import assert from 'node:assert/strict';
import test from 'node:test';
import { isRepositoryUpsert } from '../../utils/ingestionValidation.js';

const repository = {
  github_id: '136062240', owner_github_id: '2938156', full_name: 'DovAmir/awesome-design-patterns',
  owner: 'DovAmir', name: 'awesome-design-patterns', url: 'https://github.com/DovAmir/awesome-design-patterns',
  observed_at: '2026-10-24T07:43:28.857569+00:00', readme_source_path: 'README.md', readme_default_branch: 'master',
};
const commit = '9006287f27e720000cc8763ae4cd150789b8571d';
const prefix = 'https://raw.githubusercontent.com/DovAmir/awesome-design-patterns/';

test('canonical ingestion accepts immutable GitHub commit README media directories', () => {
  for (const suffix of [`${commit}/`, `${commit}/docs/`, 'refs/heads/master/']) {
    assert.equal(isRepositoryUpsert({ ...repository, readme_base_url: prefix + suffix }), true, suffix);
  }
});

test('immutable README media metadata rejects malformed commits and unsafe URLs', () => {
  for (const url of [
    prefix + commit.slice(1) + '/', prefix + commit + '0/', prefix + commit.toUpperCase() + '/',
    prefix + commit + '/docs//', prefix + commit + '/docs/../', prefix + commit + '/?token=secret',
    prefix + commit + '/#fragment', prefix.replace('https:', 'http:') + commit + '/',
    prefix.replace('raw.githubusercontent.com', 'raw.githubusercontent.com.evil.example') + commit + '/',
    prefix.replace('https://', 'https://user:secret@') + commit + '/',
  ]) assert.equal(isRepositoryUpsert({ ...repository, readme_base_url: url }), false, url);
});
