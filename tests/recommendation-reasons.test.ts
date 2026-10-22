import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';

import { decodeFeedPage, type FeedResponseV2 } from '../src/api/feed-data';
import { recommendationReason, recommendationSource } from '../src/models/recommendation';
import { mapFeedRepository } from '../src/utils/feed-repository';

function response(): FeedResponseV2 {
  return {
    serve_id: 'serve', feed_version: '7', source: 'personalized', next_cursor: 'next',
    items: [
      { repo_id: 'semantic-repo', position: 0, source: 'semantic', repository: { full_name: 'owner/semantic' } },
      { repo_id: 'trending-repo', position: 1, source: 'trending', repository: { full_name: 'owner/trending' } },
    ],
  };
}

test('nested feed sources survive decoding and canonical mapping without changing serve identity', () => {
  const page = decodeFeedPage(response(), 'session');
  const mapped = page.items.map(mapFeedRepository);
  assert.deepEqual(mapped.map(repo => repo?.recommendationSource), ['semantic', 'trending']);
  assert.deepEqual(mapped.map(repo => [repo?.id, repo?.serveId, repo?.feedPosition]), [
    ['semantic-repo', 'serve', 0], ['trending-repo', 'serve', 1],
  ]);
  assert.equal(page.nextCursor, 'next');
  assert.equal(page.feedVersion, '7');
  assert.equal(page.sessionId, 'session');
  assert.equal(recommendationReason(mapped[1]!.recommendationSource!), 'Trending on GitHub.');
});

test('legacy responses use the serve source; unknown channels cannot invent or leak a rationale', () => {
  const data = response();
  delete data.items[0].source;
  data.items[1].source = '<script>secret-inferred-attribute-score=0.99</script>';
  const mapped = decodeFeedPage(data, 'session').items.map(mapFeedRepository);
  assert.equal(mapped[0]?.recommendationSource, 'personalized');
  assert.equal(recommendationReason(mapped[0]!.recommendationSource!), 'Recommended for your feed.');
  assert.equal(mapped[1]?.recommendationSource, 'unknown');
  assert.equal(recommendationReason(mapped[1]!.recommendationSource!), 'Explore this repository.');
  delete data.source;
  assert.equal(decodeFeedPage(data, 'session').items[0].recommendation_source, 'unknown');
  for (const malformed of ['__proto__', 'constructor', {}, [], 2, null]) {
    assert.equal(recommendationSource(malformed), 'unknown');
  }
  assert.equal(mapFeedRepository({ repo_id: 'detail', full_name: 'owner/detail' })?.recommendationSource, undefined,
    'ordinary repository screens must not fabricate feed provenance');
});

test('source explanations use deterministic public copy rather than scores or inferred attributes', () => {
  assert.deepEqual(['semantic', 'personalized', 'trending', 'popular', 'fresh', 'fallback', 'unknown']
    .map(source => recommendationReason(recommendationSource(source))), [
    'Related to your interests.', 'Recommended for your feed.', 'Trending on GitHub.',
    'Popular on GitHub.', 'Recently active on GitHub.',
    'Explore a repository from our catalog.', 'Explore this repository.',
  ]);
});

test('the rendered explanation has accessible context and stays absent outside the feed', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // Exercise the actual component; substitute only native host rendering.
  const filename = resolve('src/components/home/RecommendationReason.tsx');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} as any };
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', javascript)((id: string) => id === 'react-native'
    ? { Text: 'Text', StyleSheet: { create: (styles: unknown) => styles } }
    : id === '../../constants/theme' ? { REFERENCE_THEME: { textSecondary: '#aaa' } }
      : nativeRequire(id), module, module.exports);
  const Component = module.exports.RecommendationReason;
  let root!: ReturnType<typeof create>;
  try {
    await act(async () => { root = create(React.createElement(Component, { source: 'fresh' })); });
    const text = root.root.findByType('Text');
    assert.equal(text.props.children, 'Recently active on GitHub.');
    assert.equal(text.props.accessibilityLabel, "Why you're seeing this: Recently active on GitHub.");
    assert.equal(text.props.numberOfLines, 2);
    await act(async () => { root.update(React.createElement(Component)); });
    assert.equal(root.toJSON(), null);
  } finally { if (root) await act(async () => root.unmount()); }
});
