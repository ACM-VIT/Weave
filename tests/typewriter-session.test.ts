import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import { useTypewriterText } from '../src/hooks/use-typewriter-text';
import { TypewriterCompletionCache } from '../src/services/typewriterCompletion';
import { authSessionLifecycle } from '../src/api/session-lifecycle';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Props = { source: string; enabled?: boolean; reducedMotion?: boolean; completionKey?: string };
function Probe(props: Props) {
  const result = useTypewriterText(props.source, { duration: 60, ...props });
  return React.createElement('preview', result);
}

test('completed README survives inactivity and virtualized remount without restarting timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const intervals = t.mock.method(globalThis, 'setInterval');
  let root!: ReturnType<typeof create>;
  await act(() => { root = create(React.createElement(Probe, { source: 'Tarun 🚀 summary', completionKey: 'repo-a' })); });
  await act(() => t.mock.timers.tick(0));
  await act(() => t.mock.timers.tick(120));
  assert.equal(root.root.findByType('preview').props.text, 'Tarun 🚀 summary');
  const starts = intervals.mock.callCount();
  await act(() => root.update(React.createElement(Probe, { source: 'Tarun 🚀 summary', completionKey: 'repo-a', enabled: false })));
  await act(() => t.mock.timers.tick(100));
  await act(() => root.update(React.createElement(Probe, { source: 'Tarun 🚀 summary', completionKey: 'repo-a' })));
  assert.equal(root.root.findByType('preview').props.text, 'Tarun 🚀 summary');
  await act(() => root.unmount());
  await act(() => { root = create(React.createElement(Probe, { source: 'Tarun 🚀 summary', completionKey: 'repo-a' })); });
  assert.equal(root.root.findByType('preview').props.text, 'Tarun 🚀 summary');
  assert.equal(root.root.findByType('preview').props.isTyping, false);
  await act(() => t.mock.timers.tick(120));
  assert.equal(intervals.mock.callCount(), starts, 'completed revisits start no new interval');
  await act(() => root.unmount());
});

test('new content and account sessions animate independently; reduced motion is immediate', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let root!: ReturnType<typeof create>;
  const render = (props: Props) => React.createElement(Probe, props);
  await act(() => { root = create(render({ source: 'Original', completionKey: 'repo-b' })); });
  await act(() => t.mock.timers.tick(0));
  await act(() => t.mock.timers.tick(120));
  await act(() => root.update(render({ source: 'Changed content', completionKey: 'repo-b' })));
  assert.equal(root.root.findByType('preview').props.text, '');
  await act(() => t.mock.timers.tick(0));
  await act(() => t.mock.timers.tick(120));
  await act(() => { authSessionLifecycle.retire(authSessionLifecycle.currentGeneration()); });
  assert.equal(root.root.findByType('preview').props.text, '');
  await act(() => root.update(render({ source: 'No animation 🚀', completionKey: 'repo-b', reducedMotion: true })));
  assert.equal(root.root.findByType('preview').props.text, 'No animation 🚀');
  assert.equal(root.root.findByType('preview').props.isTyping, false);
  await act(() => root.unmount());
});

test('completion storage bounds both entries and retained content, replacing changed versions', () => {
  const cache = new TypewriterCompletionCache(2, 20);
  cache.complete('a', 'one'); cache.complete('b', 'two');
  assert.equal(cache.has('a', 'one'), true);
  cache.complete('c', 'three');
  assert.equal(cache.has('b', 'two'), false);
  cache.complete('a', 'changed');
  assert.equal(cache.has('a', 'one'), false);
  assert.equal(cache.has('a', 'changed'), true);
  cache.complete('huge', 'x'.repeat(21));
  assert.equal(cache.has('huge', 'x'.repeat(21)), false);
  cache.clear(); assert.equal(cache.has('a', 'changed'), false);
});
