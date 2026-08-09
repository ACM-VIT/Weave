import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRepositoryShareContent,
  buildRepositoryWebUrl,
  normalizePublicWebUrl,
  parseRepositoryIdFromLink,
  repositoryHref,
  repositoryHrefFromLink,
  repositoryPath,
  resolveRepositoryShareUrl,
} from '../src/utils/repository-links';

test('repository routes keep the raw parameter separate from the encoded path', () => {
  assert.equal(repositoryPath(' repo id '), '/repository/repo%20id');
  assert.deepEqual(repositoryHref(' repo id '), {
    pathname: '/repository/[repoId]',
    params: { repoId: 'repo id' },
  });
  assert.throws(() => repositoryPath('  '), /Repository ID is required/);
});

test('public web URL accepts a secure origin and rejects placeholders or path prefixes', () => {
  assert.equal(normalizePublicWebUrl('https://weave.example.com/'), 'https://weave.example.com');
  assert.equal(normalizePublicWebUrl('http://localhost:8081/'), 'http://localhost:8081');
  assert.equal(normalizePublicWebUrl('https://your-web-frontend.example'), null);
  assert.equal(normalizePublicWebUrl('http://weave.example.com'), null);
  assert.equal(normalizePublicWebUrl('https://weave.example.com/app'), null);
  assert.equal(normalizePublicWebUrl('https://weave.example.com/?from=test'), null);
  assert.equal(normalizePublicWebUrl(undefined), null);
});

test('configured web origin builds the canonical repository URL', () => {
  assert.equal(
    buildRepositoryWebUrl('7be6d88f', 'https://weave.example.com/'),
    'https://weave.example.com/repository/7be6d88f',
  );
  assert.equal(
    buildRepositoryWebUrl('7be6d88f', 'https://your-web-frontend.example'),
    null,
  );
});

test('relative, custom-scheme, Expo Go, and configured HTTPS links resolve one route', () => {
  const repoId = '7be6d88f';
  const webBaseUrl = 'https://weave.example.com';
  assert.equal(parseRepositoryIdFromLink(`/repository/${repoId}`), repoId);
  assert.equal(parseRepositoryIdFromLink(`repository/${repoId}`), repoId);
  assert.equal(parseRepositoryIdFromLink(`ghsocial://repository/${repoId}`), repoId);
  assert.equal(parseRepositoryIdFromLink(`ghsocial:///repository/${repoId}`), repoId);
  assert.equal(parseRepositoryIdFromLink(`exp://127.0.0.1:8081/--/repository/${repoId}`), repoId);
  assert.equal(
    parseRepositoryIdFromLink(`${webBaseUrl}/repository/${repoId}`, webBaseUrl),
    repoId,
  );
  assert.deepEqual(repositoryHrefFromLink(`ghsocial://repository/${repoId}`), {
    pathname: '/repository/[repoId]',
    params: { repoId },
  });
});

test('repository link parser rejects foreign, malformed, and unconfigured web links', () => {
  assert.equal(parseRepositoryIdFromLink('https://github.com/acme/project'), null);
  assert.equal(
    parseRepositoryIdFromLink(
      'https://other.example.com/repository/7be6d88f',
      'https://weave.example.com',
    ),
    null,
  );
  assert.equal(parseRepositoryIdFromLink('https://weave.example.com/repository/7be6d88f'), null);
  assert.equal(parseRepositoryIdFromLink('ghsocial://other/repository/7be6d88f'), null);
  assert.equal(parseRepositoryIdFromLink('/repository/owner%2Frepo'), null);
  assert.equal(parseRepositoryIdFromLink('/repository/'), null);
});

test('share URL prefers configured web origin and otherwise requires the matching native route', () => {
  assert.equal(resolveRepositoryShareUrl({
    repoId: '7be6d88f',
    webBaseUrl: 'https://weave.example.com',
    nativeUrl: 'ghsocial://repository/7be6d88f',
  }), 'https://weave.example.com/repository/7be6d88f');

  assert.equal(resolveRepositoryShareUrl({
    repoId: '7be6d88f',
    webBaseUrl: 'https://your-web-frontend.example',
    nativeUrl: 'ghsocial://repository/7be6d88f',
  }), 'ghsocial://repository/7be6d88f');

  assert.throws(() => resolveRepositoryShareUrl({
    repoId: '7be6d88f',
    nativeUrl: 'https://github.com/acme/project',
  }), /valid native Weave repository link/);
});

test('share content names Weave and uses the canonical Weave URL', () => {
  const url = 'ghsocial://repository/7be6d88f';
  assert.deepEqual(buildRepositoryShareContent('acme/project', url), {
    title: 'acme/project on Weave',
    message: `View acme/project on Weave:\n${url}`,
    url,
  });
});
