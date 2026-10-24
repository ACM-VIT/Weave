import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { isRepositoryUpsert } from "../../utils/ingestionValidation.js";
import { validateRepositoryLifecycle } from "../../services/repositoryLifecycle.js";

describe("immutableReadme", () => {
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
});

describe("repositoryLifecycle", () => {
  const lifecycle = { status: 'verified', source: 'github-rest-repository', observed_at: '2026-01-02T00:00:00Z', archived: false, disabled: true };

  test('authenticated ingestion accepts complete lifecycle evidence and rejects partial or fabricated statuses', () => {
    const repository = { github_id: '123', owner_github_id: '456', full_name: 'owner/repo',
      owner: 'owner', name: 'repo', url: 'https://github.com/owner/repo', observed_at: '2026-01-03T00:00:00Z' };
    validateRepositoryLifecycle(lifecycle);
    validateRepositoryLifecycle({ ...lifecycle, observed_at: '2026-01-02T05:30:00+05:30' });
    validateRepositoryLifecycle({ ...lifecycle, observed_at: '0001-01-02T00:00:00.123456+23:59' });
    validateRepositoryLifecycle({ status: 'unavailable', source: lifecycle.source, observed_at: lifecycle.observed_at, archived: null, disabled: null });
    assert.equal(isRepositoryUpsert({ ...repository, lifecycle }), true);
    validateRepositoryLifecycle({ status: 'unavailable', source: lifecycle.source, observed_at: lifecycle.observed_at });
    for (const invalid of [
      { ...lifecycle, disabled: null }, { ...lifecycle, archived: 'false' },
      { ...lifecycle, source: ['github-rest-repository'] },
      { ...lifecycle, source: 'push-recency' }, { ...lifecycle, observed_at: '2026-01-02T00:00:00' },
      { ...lifecycle, observed_at: '2999-01-01T00:00:00Z' },
      { ...lifecycle, observed_at: '0000-01-01T00:00:00Z' },
      { ...lifecycle, observed_at: '0001-01-01T00:00:00+23:59' },
      { ...lifecycle, observed_at: '9999-12-31T23:59:59-23:59' },
      { ...lifecycle, observed_at: '2026-02-30T00:00:00Z' },
      { ...lifecycle, observed_at: '2026-01-02T24:00:00Z' },
      { ...lifecycle, status: 'unavailable' }, { ...lifecycle, injected: true },
    ]) {
      assert.throws(() => validateRepositoryLifecycle(invalid));
      assert.equal(isRepositoryUpsert({ ...repository, lifecycle: invalid }), false);
    }
  });
});
