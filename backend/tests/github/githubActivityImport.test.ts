import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { GitHubActivityImportClient, GitHubActivityImportError } from '../../services/githubActivityImport.js';

function repository(id: number | string, overrides: Record<string, unknown> = {}) {
  return { id, owner: { id: '7', login: 'viewer' }, name: `repo${id}`, full_name: `viewer/repo${id}`,
    html_url: `https://github.com/viewer/repo${id}`, private: false, visibility: 'public', fork: false,
    description: 'Public repository', language: 'TypeScript', topics: ['testing'], updated_at: '2026-10-01T00:00:00Z', ...overrides };
}
function contribution(id: number) {
  return { databaseId: id, owner: { databaseId: 7, login: 'viewer' }, name: `repo${id}`, nameWithOwner: `viewer/repo${id}`,
    url: `https://github.com/viewer/repo${id}`, isPrivate: false, visibility: 'PUBLIC', isFork: false,
    description: 'Public repository', updatedAt: '2026-10-01T00:00:00Z', primaryLanguage: { name: 'TypeScript' }, repositoryTopics: { nodes: [{ topic: { name: 'testing' } }] } };
}
function graph(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { data: { user: { databaseId: 7, repositoriesContributedTo: { nodes, pageInfo: { hasNextPage, endCursor } } } } };
}
async function fixture(handler: (url: URL, body: Record<string, unknown>, response: http.ServerResponse) => void) {
  const requests: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const url = new URL(request.url!, 'http://localhost');
    requests.push({ url: request.url!, body, auth: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/users/viewer') response.end(JSON.stringify({ id: 7, login: 'viewer' }));
    else handler(url, body, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address.');
  const transport: typeof fetch = (input, init) => {
    const requested = new URL(String(input));
    assert.equal(requested.origin, 'https://api.github.com');
    assert.equal(init?.redirect, 'error', 'credentials must never follow redirects');
    return fetch(`http://127.0.0.1:${address.port}${requested.pathname}${requested.search}`, init);
  };
  return { requests, transport, async stop() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test('real HTTP paginates public owned/starred/contributed sources and merges canonical IDs with provenance', async () => {
  const f = await fixture((url, body, response) => {
    if (url.pathname.endsWith('/repos')) response.end(JSON.stringify(url.searchParams.get('page') === '1'
      ? [repository(1), repository(2, { private: true })] : [repository(3)]));
    else if (url.pathname.endsWith('/starred')) response.end(JSON.stringify([repository(1)]));
    else {
      assert.match(String(body.query), /privacy:PUBLIC/);
      const variables = body.variables as { after: string | null; first: number };
      assert.equal(variables.first, 2);
      response.end(JSON.stringify(variables.after === null ? graph([contribution(4)], true, 'next') : graph([contribution(1)])));
    }
  });
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture-only', fetch: f.transport, pageSize: 2 }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.repositories.map(row => row.github_id), ['1', '3', '4']);
    assert.deepEqual(result.repositories[0].sources, ['owned', 'starred', 'contributed']);
    assert.equal(result.repositories[0].owner_github_id, '7');
    assert.equal(result.repositories[0].updated_at, '2026-10-01T00:00:00Z', 'source update time is distinct from collection time');
    assert.equal(result.sources.owned.pages, 2);
    assert.equal(result.sources.contributed.pages, 2);
    assert.equal(new Date(result.collected_at).toISOString(), result.collected_at);
    assert.ok(f.requests.every(request => request.auth === 'Bearer fixture-only'));
    assert.ok(!JSON.stringify(result).includes('fixture-only'));
  } finally { await f.stop(); }
});

test('resource limits produce an explicit truncated source rather than pretending the graph is complete', async () => {
  const f = await fixture((url, _body, response) => response.end(JSON.stringify(url.pathname === '/graphql'
    ? graph([]) : url.pathname.endsWith('/repos') ? [repository(Number(url.searchParams.get('page')))] : [])));
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport, pageSize: 1, maxPages: 2 }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.sources.owned, { status: 'truncated', pages: 2, count: 2 });
    assert.equal(f.requests.filter(row => row.url.includes('/repos?')).length, 2);
  } finally { await f.stop(); }
});

test('rate limits and malformed pages remain explicit partial errors without discarding successful sources', async () => {
  const f = await fixture((url, _body, response) => {
    if (url.pathname.endsWith('/repos')) response.end(JSON.stringify([repository(1)]));
    else if (url.pathname.endsWith('/starred')) { response.writeHead(429, { 'Retry-After': '120' }); response.end('{}'); }
    else response.end(JSON.stringify(graph([contribution(2), { ...contribution(3), databaseId: Number.MAX_SAFE_INTEGER + 1 }])));
  });
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.repositories.map(row => row.github_id), ['1'], 'an invalid page never partly enters the snapshot');
    assert.equal(result.sources.starred.error_code, 'rate_limited');
    assert.equal(result.sources.starred.retry_after_seconds, 120);
    assert.equal(result.sources.contributed.error_code, 'invalid_numeric_identity');
  } finally { await f.stop(); }
});

test('a renamed/taken-over handle cannot select an unverified provider identity', async () => {
  const f = await fixture((_url, _body, response) => response.end('[]'));
  try {
    await assert.rejects(new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport }).collect({ githubId: '8', handle: 'viewer' }),
      (error: unknown) => error instanceof GitHubActivityImportError && error.code === 'provider_identity_changed');
    assert.equal(f.requests.length, 1);
  } finally { await f.stop(); }
});

test('private/internal/unknown visibility is filtered even behind a privileged credential', async () => {
  const f = await fixture((url, _body, response) => response.end(JSON.stringify(url.pathname === '/graphql' ? graph([
    { ...contribution(5), isPrivate: true }, { ...contribution(6), visibility: 'INTERNAL' },
  ]) : url.pathname.endsWith('/repos') ? [repository(1, { private: true }), repository(2, { visibility: 'internal' }), repository(3, { private: undefined })] : [])));
  try {
    const result = await new GitHubActivityImportClient({ token: 'privileged-fixture', fetch: f.transport }).collect({ githubId: '7', handle: 'viewer' });
    assert.deepEqual(result.repositories, []);
    assert.equal(result.status, 'complete');
  } finally { await f.stop(); }
});

test('repeated contribution cursors and oversized bodies stop bounded acquisition', async () => {
  const f = await fixture((url, _body, response) => response.end(url.pathname === '/graphql'
    ? JSON.stringify(graph([contribution(1)], true, 'repeat')) : url.pathname.endsWith('/repos') ? ' '.repeat(2_001) : '[]'));
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport, maxBodyBytes: 2_000 }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.sources.owned.error_code, 'response_too_large');
    assert.equal(result.sources.contributed.error_code, 'repeated_cursor');
    assert.equal(result.sources.contributed.pages, 1);
  } finally { await f.stop(); }
});

test('one overall deadline aborts a stalled source and never starts further provider work', async () => {
  const f = await fixture((_url, _body, _response) => { /* actual HTTP remains open until abort */ });
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport, timeoutMs: 200 }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.status, 'partial');
    assert.ok(Object.values(result.sources).every(source => source.error_code === 'deadline_exceeded'));
    assert.equal(f.requests.length, 2, 'only profile and the first source reached HTTP');
  } finally { await f.stop(); }
});

test('owned-source and conflicting immutable owner IDs cannot contaminate any accepted page', async () => {
  const f = await fixture((url, _body, response) => {
    const valid = repository(1);
    const conflicting = repository(1, { owner: { id: '9', login: 'viewer' } });
    response.end(JSON.stringify(url.pathname === '/graphql' ? graph([])
      : url.pathname.endsWith('/repos') ? [conflicting] : [valid, conflicting]));
  });
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport }).collect({ githubId: '7', handle: 'viewer' });
    assert.deepEqual(result.repositories, []);
    assert.equal(result.sources.owned.error_code, 'invalid_owned_repository');
    assert.equal(result.sources.starred.error_code, 'conflicting_repository_identity');
  } finally { await f.stop(); }
});

test('actual redirects cannot forward the configured service credential', async () => {
  const f = await fixture((url, _body, response) => {
    if (url.pathname.endsWith('/repos')) { response.writeHead(302, { Location: '/credential-target' }); response.end(); }
    else response.end(JSON.stringify(url.pathname === '/graphql' ? graph([]) : []));
  });
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.sources.owned.error_code, 'transport_error');
    assert.equal(f.requests.some(request => request.url === '/credential-target'), false);
  } finally { await f.stop(); }
});

test('invalid resource settings fail before HTTP and pre-cancelled acquisition sends nothing', async () => {
  for (const options of [{ maxPages: 6 }, { pageSize: 101 }, { timeoutMs: 0 }, { maxBodyBytes: Infinity }]) {
    assert.throws(() => new GitHubActivityImportClient({ token: 'fixture', ...options }), /resource limit/);
  }
  const f = await fixture((_url, _body, response) => response.end('[]'));
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport }).collect({ githubId: '7', handle: 'viewer' }, cancelled.signal),
      (error: unknown) => error instanceof GitHubActivityImportError && error.code === 'cancelled');
    assert.equal(f.requests.length, 0);
  } finally { await f.stop(); }
});
