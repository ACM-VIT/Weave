import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';
import { parseRepositoryLabel } from '../src/models/repository-label';
import { decodeFeedPage } from '../src/api/feed-data';
import { mapFeedRepository } from '../src/utils/feed-repository';

const now = Date.parse('2026-10-24T18:00:00Z');
function fixtures(at = now) {
  const freshness = { observed_at: new Date(at - 60_000).toISOString(), expires_at: new Date(at + 60_000).toISOString() };
  return [
    { ...freshness, kind: 'trending', rank: 3, period: 'daily', source: 'github-trending' },
    { ...freshness, kind: 'recent_likes', rank: 2, count: 27, window_hours: 168 },
    { ...freshness, kind: 'popular', star_count: 10_000 },
  ];
}

test('validated label metadata keeps only supported fields and rejects stale or ambiguous claims', () => {
  for (const row of fixtures()) assert.deepEqual(parseRepositoryLabel({ ...row, text: '<private>' }, now), row);
  const [trend, likes, popular] = fixtures();
  for (const value of [undefined, null, [], 'trending', { ...trend, kind: '__proto__' },
    { ...trend, rank: 11 }, { ...trend, rank: 0 }, { ...trend, rank: 1.5 }, { ...trend, rank: '3' },
    { ...trend, source: 'trending' }, { ...trend, period: 'weekly' },
    { ...trend, expires_at: new Date(now).toISOString() }, { ...trend, observed_at: new Date(now + 1).toISOString() },
    { ...trend, observed_at: '2026-10-24' }, { ...trend, expires_at: 'invalid' },
    { ...likes, count: 0 }, { ...likes, rank: 11 }, { ...likes, window_hours: 24 },
    { ...popular, star_count: Infinity }, { ...popular, star_count: -1 },
  ]) assert.equal(parseRepositoryLabel(value, now), null, JSON.stringify(value));
});

test('nested repository label survives feed decode and mapping without changing provenance', () => {
  const label = fixtures(Date.now())[0];
  const page = decodeFeedPage({ serve_id: 'serve', feed_version: 'v1', source: 'personalized', next_cursor: null,
    items: [{ repo_id: 'repo', position: 98, source: 'semantic', repository: { full_name: 'owner/repo', label } }] }, 'session');
  const repository = mapFeedRepository(page.items[0]);
  assert.deepEqual(repository?.label, label);
  assert.equal(repository?.recommendationSource, 'semantic');
  assert.equal(repository?.feedPosition, 98);
  assert.equal(repository?.serveId, 'serve');
  assert.equal(mapFeedRepository({ repo_id: 'repo', full_name: 'owner/repo', label: { ...label, rank: 11 } })?.label, null);
  assert.equal(mapFeedRepository({ repo_id: 'repo', full_name: 'owner/repo' })?.label, null);
});

function renderer() {
  const listeners = new Set<(state: string) => void>();
  const theme = { textSecondary: '#aaa', repositoryLabel: {
    trending: { color: '#E9C28B', backgroundColor: '#201B13', borderColor: '#51422D' },
    recentLikes: { color: '#A3E6B1', backgroundColor: '#112019', borderColor: '#2F4B36' },
    popular: { color: '#C3CEC5', backgroundColor: '#171C18', borderColor: '#343D36' },
  } };
  const load = (relative: string): any => {
    const filename = resolve(relative), nativeRequire = createRequire(filename), module = { exports: {} as any };
    const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    new Function('require', 'module', 'exports', javascript)((id: string) => {
      if (id === 'react-native') return { Text: 'Text', View: 'View', StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        AppState: { addEventListener: (_: string, callback: (state: string) => void) => {
          listeners.add(callback); return { remove: () => listeners.delete(callback) };
        } } };
      if (id === '../../constants/theme') return { REFERENCE_THEME: theme };
      if (id === 'lucide-react-native') return { Star: 'Star', ThumbsUp: 'ThumbsUp', TrendingUp: 'TrendingUp' };
      if (id === './repository-label-presentation') return load('src/components/home/repository-label-presentation.ts');
      return nativeRequire(id);
    }, module, module.exports);
    return module.exports;
  };
  return { Component: load('src/components/home/RecommendationReason.tsx').RecommendationReason, listeners };
}

test('badge renders one accessible phrase, allows wrapping and retains source fallback', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { Component, listeners } = renderer();
  let root!: ReturnType<typeof create>;
  try {
    for (const label of fixtures(Date.now())) {
      await act(async () => { root ? root.update(React.createElement(Component, { source: 'semantic', label }))
        : root = create(React.createElement(Component, { source: 'semantic', label })); });
      const badge = root.root.findByProps({ testID: 'repository-label' });
      assert.equal(badge.props.accessible, true);
      assert.equal(badge.props.accessibilityRole, 'text');
      assert.equal(badge.props.onPress, undefined);
      assert.ok(badge.props.accessibilityLabel.includes(label.kind === 'recent_likes' ? 'last seven days' : 'GitHub'));
      const text = root.root.findByType('Text');
      assert.equal(text.props.numberOfLines, undefined, 'no clipping at large font scales or narrow widths');
      assert.equal(text.props.allowFontScaling, undefined, 'native scaling remains enabled');
      assert.equal(root.root.findAllByProps({ testID: 'recommendation-reason' }).length, 0);
    }
    await act(async () => { root.update(React.createElement(Component, { source: 'semantic', label: { ...fixtures()[0], kind: 'future' } })); });
    assert.equal(root.root.findByType('Text').props.children, 'Related to your interests.');
    await act(async () => { root.update(React.createElement(Component)); });
    assert.equal(root.toJSON(), null);
    assert.equal(listeners.size, 0);
  } finally { if (root) await act(async () => root.unmount()); }
});

test('mounted cached label expires and falls back without requiring another network response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { Component, listeners } = renderer();
  const label = { ...fixtures(Date.now())[0], expires_at: new Date(Date.now() + 150).toISOString() };
  let root!: ReturnType<typeof create>;
  try {
    await act(async () => { root = create(React.createElement(Component, { source: 'fresh', label })); });
    assert.equal(root.root.findAllByProps({ testID: 'repository-label' }).length, 1);
    await act(async () => { t.mock.timers.tick(180); });
    assert.equal(root.root.findAllByProps({ testID: 'repository-label' }).length, 0);
    assert.equal(root.root.findByType('Text').props.children, 'Recently active on GitHub.');
    await act(async () => { for (const listener of listeners) listener('active'); });
    assert.equal(root.root.findAllByProps({ testID: 'repository-label' }).length, 0);
  } finally { if (root) await act(async () => root.unmount()); }
  t.mock.timers.reset();
  assert.equal(listeners.size, 0);
});

test('trending retrieval provenance and feed position cannot invent a ranked badge', async () => {
  const page = decodeFeedPage({ serve_id: 'serve', feed_version: 'v1', source: 'personalized', next_cursor: null,
    items: [{ repo_id: 'repo', position: 2, source: 'trending', repository: { full_name: 'owner/repo' } }] }, 'session');
  const repository = mapFeedRepository(page.items[0]);
  assert.equal(repository?.label, null);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { Component } = renderer();
  let root!: ReturnType<typeof create>;
  try {
    await act(async () => { root = create(React.createElement(Component,
      { source: repository?.recommendationSource, label: repository?.label })); });
    assert.equal(root.root.findAllByProps({ testID: 'repository-label' }).length, 0);
    assert.equal(root.root.findByType('Text').props.children, 'Trending on GitHub.');
  } finally { if (root) await act(async () => root.unmount()); }
});
