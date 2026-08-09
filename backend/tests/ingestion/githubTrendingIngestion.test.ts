import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubTrendingIngestionService } from '../../services/githubTrendingIngestionService.js';

const NOW = new Date('2026-08-02T06:00:00.000Z');

const candidate = {
  id: 123,
  node_id: 'R_repo',
  name: 'persona-engine',
  full_name: 'weave/persona-engine',
  html_url: 'https://github.com/weave/persona-engine',
  description: 'Personalized discovery',
  owner: { id: 456, login: 'weave' },
  language: 'TypeScript',
  topics: ['recommendation-system'],
  stargazers_count: 900,
  forks_count: 45,
  open_issues_count: 7,
  created_at: '2026-07-15T00:00:00.000Z',
  updated_at: '2026-08-02T00:00:00.000Z',
  pushed_at: '2026-08-01T00:00:00.000Z',
  default_branch: 'main',
  archived: false,
  fork: false,
};

test('trending ingestion builds a deterministic enriched candidate corpus for ML ranking', async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requested.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/search/repositories') {
      return Response.json({ items: [candidate] });
    }
    if (url.pathname.endsWith('/languages')) {
      return Response.json({ TypeScript: 1000, Python: 200 });
    }
    if (url.pathname.endsWith('/readme')) {
      return Response.json({
        encoding: 'base64',
        content: Buffer.from('# Persona engine\n\n![Preview](./assets/preview.png)').toString('base64'),
        path: 'docs/README.md',
        download_url: 'https://raw.githubusercontent.com/weave/persona-engine/main/docs/README.md',
      });
    }
    return new Response('not found', { status: 404 });
  };
  const service = new GitHubTrendingIngestionService({
    token: 'test-token', fetchImpl, now: () => NOW, limit: 10, enrichmentConcurrency: 2,
  });

  const first = await service.buildSnapshot();
  const second = await service.buildSnapshot();

  assert.equal(first.snapshot_id, second.snapshot_id);
  assert.match(first.snapshot_id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first.source, 'github-search-persona-corpus-v1');
  assert.equal(first.repositories.length, 1, 'duplicate search results are canonicalized by GitHub numeric ID');
  assert.deepEqual(first.repositories[0], {
    github_id: '123',
    github_node_id: 'R_repo',
    owner_github_id: '456',
    full_name: 'weave/persona-engine',
    owner: 'weave',
    name: 'persona-engine',
    url: 'https://github.com/weave/persona-engine',
    description: 'Personalized discovery',
    readme: '# Persona engine\n\n![Preview](./assets/preview.png)',
    readme_source_path: 'docs/README.md',
    readme_default_branch: 'main',
    readme_base_url: 'https://raw.githubusercontent.com/weave/persona-engine/refs/heads/main/docs/',
    readme_length: 50,
    primary_language: 'TypeScript',
    languages: ['TypeScript', 'Python'],
    topics: ['recommendation-system'],
    star_count: 900,
    fork_count: 45,
    open_issues_count: 7,
    pushed_days_ago: 1,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
    pushed_at: candidate.pushed_at,
    discovery_category: 'github-trending',
    discovery_band: 'breakout',
    observed_at: NOW.toISOString(),
    rank: 0,
    score: first.repositories[0].score,
  });
  assert.ok(Number(first.repositories[0].score) > 0);
  assert.ok(requested.some((path) => path.includes('created%3A%3E%3D2026-05-04')));
  assert.ok(requested.some((path) => path.includes('pushed%3A%3E%3D2026-07-26')));
});

test('trending ingestion fails closed when GitHub provides no eligible repositories', async () => {
  const service = new GitHubTrendingIngestionService({
    token: 'test-token',
    fetchImpl: async () => Response.json({ items: [] }),
    now: () => NOW,
  });
  await assert.rejects(service.buildSnapshot(), /no eligible trending repositories/i);
});

test('trending ingestion excludes an oversized README instead of publishing a destructive null update', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/search/repositories') return Response.json({ items: [candidate] });
    if (path.endsWith('/languages')) return Response.json({ TypeScript: 1 });
    if (path.endsWith('/readme')) return Response.json({
      encoding: 'base64',
      content: Buffer.from('x'.repeat(1_000_001)).toString('base64'),
      path: 'README.md',
      download_url: 'https://raw.githubusercontent.com/weave/persona-engine/main/README.md',
    });
    return new Response('not found', { status: 404 });
  };
  const service = new GitHubTrendingIngestionService({
    token: 'test-token', fetchImpl, now: () => NOW,
  });
  await assert.rejects(service.buildSnapshot(), /no enrichable trending repositories/i);
});

test('trending ingestion excludes retryable README failures so prior canonical content cannot be cleared', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/search/repositories') return Response.json({ items: [candidate] });
    if (path.endsWith('/languages')) return Response.json({ TypeScript: 1 });
    if (path.endsWith('/readme')) return new Response('temporarily unavailable', { status: 503 });
    return new Response('not found', { status: 404 });
  };
  const service = new GitHubTrendingIngestionService({
    token: 'test-token', fetchImpl, now: () => NOW,
  });
  await assert.rejects(service.buildSnapshot(), /no enrichable trending repositories/i);
});

test('trending ingestion treats only a confirmed README 404 as intentional absence', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/search/repositories') return Response.json({ items: [candidate] });
    if (path.endsWith('/languages')) return Response.json({ TypeScript: 1 });
    if (path.endsWith('/readme')) return new Response('not found', { status: 404 });
    return new Response('not found', { status: 404 });
  };
  const snapshot = await new GitHubTrendingIngestionService({
    token: 'test-token', fetchImpl, now: () => NOW,
  }).buildSnapshot();
  assert.equal(snapshot.repositories[0].readme, null);
  assert.equal(snapshot.repositories[0].readme_length, 0);
  assert.equal(snapshot.repositories[0].readme_source_path, null);
});

test('trending ingestion excludes a malformed successful README response instead of clearing content', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/search/repositories') return Response.json({ items: [candidate] });
    if (path.endsWith('/languages')) return Response.json({ TypeScript: 1 });
    if (path.endsWith('/readme')) return Response.json({ path: 'README.md' });
    return new Response('not found', { status: 404 });
  };
  const service = new GitHubTrendingIngestionService({
    token: 'test-token', fetchImpl, now: () => NOW,
  });
  await assert.rejects(service.buildSnapshot(), /no enrichable trending repositories/i);
});

test('trending ingestion excludes language-fetch failures rather than erasing known languages', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/search/repositories') return Response.json({ items: [candidate] });
    if (path.endsWith('/languages')) return new Response('temporarily unavailable', { status: 503 });
    if (path.endsWith('/readme')) return Response.json({
      encoding: 'base64',
      content: Buffer.from('# Canonical README').toString('base64'),
      path: 'README.md',
      download_url: 'https://raw.githubusercontent.com/weave/persona-engine/main/README.md',
    });
    return new Response('not found', { status: 404 });
  };
  const service = new GitHubTrendingIngestionService({
    token: 'test-token', fetchImpl, now: () => NOW,
  });
  await assert.rejects(service.buildSnapshot(), /no enrichable trending repositories/i);
});

test('trending ingestion trusts README media bases only from clean raw.githubusercontent.com URLs', async () => {
  for (const downloadUrl of [
    'https://raw.githubusercontent.com.evil.example/weave/persona-engine/main/docs/README.md',
    'https://raw.githubusercontent.com/weave/persona-engine/main/docs/README.md?token=secret',
    'https://user:secret@raw.githubusercontent.com/weave/persona-engine/main/docs/README.md',
  ]) {
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/search/repositories') return Response.json({ items: [candidate] });
      if (path.endsWith('/languages')) return Response.json({ TypeScript: 1 });
      if (path.endsWith('/readme')) return Response.json({
        encoding: 'base64',
        content: Buffer.from('# Safe canonical Markdown').toString('base64'),
        path: 'docs/README.md',
        download_url: downloadUrl,
      });
      return new Response('not found', { status: 404 });
    };
    const snapshot = await new GitHubTrendingIngestionService({
      token: 'test-token', fetchImpl, now: () => NOW,
    }).buildSnapshot();
    assert.equal(snapshot.repositories[0].readme, '# Safe canonical Markdown');
    assert.equal(snapshot.repositories[0].readme_base_url, null);
  }
});
