import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const internalSurfaceFiles = [
  'src/models/search.ts',
  'src/app/(tabs)/home.tsx',
  'src/app/board.tsx',
  'src/app/user/[username].tsx',
  'src/components/liked-repositories-screen.tsx',
  'src/components/profile-repository-list.tsx',
] as const;

test('internal repository surfaces route to Weave rather than opening GitHub', async () => {
  for (const path of internalSurfaceFiles) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(source, /repositoryHref\(/, `${path} must use the canonical repository route`);
    assert.doesNotMatch(source, /Linking\.openURL/, `${path} must not open GitHub directly`);
  }
});

test('Explore uses the shared internal search result router', async () => {
  const source = await readFile(new URL('../src/app/(tabs)/explore.tsx', import.meta.url), 'utf8');
  assert.match(source, /router\.push\(searchResultHref\(item\)\)/);
  assert.doesNotMatch(source, /Linking\.openURL/);
});

test('the dynamic repository route renders the canonical detail screen', async () => {
  const source = await readFile(
    new URL('../src/app/repository/[repoId].tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /RepositoryDetailScreen/);
  assert.match(source, /repoId/);
});

test('feed and Trending cards delegate repository presses to internal navigation', async () => {
  const feedItem = await readFile(
    new URL('../src/components/home/RepositoryFeedItem.tsx', import.meta.url),
    'utf8',
  );
  const trendingCard = await readFile(
    new URL('../src/components/explore/TrendingRepoCard.tsx', import.meta.url),
    'utf8',
  );

  assert.match(feedItem, /onRepositoryPress=\{onRepositoryPress\}/);
  assert.doesNotMatch(feedItem, /Linking\.openURL/);
  assert.match(trendingCard, /onPress=\{onPress\}/);
  assert.doesNotMatch(trendingCard, /Linking\.openURL/);
});

test('profile repository sheets dismiss before navigating to repository details', async () => {
  const list = await readFile(
    new URL('../src/components/profile-repository-list.tsx', import.meta.url),
    'utf8',
  );
  const sheet = await readFile(
    new URL('../src/components/connection-sheet.tsx', import.meta.url),
    'utf8',
  );

  assert.match(list, /onRepositoryPress\(repositoryHref\(item\.id\)\)/);
  assert.match(sheet, /afterCloseRef\.current = \(\) => onRepositoryPress\(href\)/);
  assert.match(sheet, /onClose\(\);\s*afterClose\?\.\(\)/);
});

test('every intentional GitHub escape has an explicit visible Open on GitHub action', async () => {
  for (const path of [
    'src/components/home/RepositoryScreen.tsx',
    'src/components/repository-detail-screen.tsx',
    'src/components/home/share-repository-sheet.tsx',
  ]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(source, /Linking\.openURL/, `${path} must contain the intentional external open`);
    assert.match(source, />Open on GitHub<|label="Open on GitHub"/, `${path} must visibly label the external action`);
  }
});

test('README GitHub links use the shared explicit confirmation policy', async () => {
  const popup = await readFile(
    new URL('../src/components/home/ReadmePopup.tsx', import.meta.url),
    'utf8',
  );
  assert.match(popup, /openReadmeExternalLink\(href\)/);
  assert.doesNotMatch(popup, /Linking\.openURL/);

  const policy = await readFile(
    new URL('../src/utils/readme-external-link.ts', import.meta.url),
    'utf8',
  );
  assert.match(policy, /Platform\.OS === 'web'[\s\S]*window\.confirm/);
  assert.match(policy, /Alert\.alert/);

  const card = await readFile(
    new URL('../src/components/home/ReadmeCard.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(card, /RenderHtml|Linking\.openURL/);

  assert.match(policy, /isGithubReadmeLink\(href\)/);
  assert.match(policy, /Alert\.alert\(/);
  assert.match(policy, /text: 'Open on GitHub'/);
  assert.match(policy, /hostname === 'github\.com'/);
});
