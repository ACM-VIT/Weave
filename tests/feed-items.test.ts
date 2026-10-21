import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedItemMapper, mapBackendToFrontend } from '../src/utils/feed-items';

function item(id: string, fields: Record<string, unknown> = {}) {
  return { repo_id: id, full_name: `owner/${id}`, serve_id: 'serve-1', position: 0, ...fields };
}

test('appending one page only maps new objects and retains existing cards', () => {
  let mapped = 0;
  const project = createFeedItemMapper(value => { mapped++; return mapBackendToFrontend(value); });
  const pages = Array.from({ length: 100 }, (_, page) => ({
    items: Array.from({ length: 24 }, (_, row) => item(`${page}-${row}`, { position: row })),
  }));
  const before = project(pages);
  assert.equal(mapped, 2_400);
  const after = project([...pages, { items: Array.from({ length: 24 }, (_, row) => item(`new-${row}`)) }]);
  assert.equal(mapped, 2_424);
  assert.equal(after.length, 2_424);
  before.forEach((entry, index) => assert.strictEqual(after[index], entry));
  assert.strictEqual(project([...pages]), project(pages));
});

test('mutation updates only the changed entry and keeps its serve attribution', () => {
  let mapped = 0;
  const project = createFeedItemMapper(value => { mapped++; return mapBackendToFrontend(value); });
  const first = item('first');
  const second = item('second', { position: 1 });
  const before = project([{ items: [first, second] }]);
  const after = project([{ items: [first, { ...second, viewer_reaction: 'like', viewer_saved: true }] }]);
  assert.equal(mapped, 3);
  assert.strictEqual(after[0], before[0]);
  assert.notStrictEqual(after[1], before[1]);
  assert.equal(after[1].feedId, before[1].feedId, 'Reactions and saves must not remount the card');
  assert.equal(after[1].repository.viewerReaction, 'like');
  assert.equal(after[1].repository.viewerSaved, true);
  assert.equal(after[1].repository.serveId, 'serve-1');
  assert.equal(after[1].repository.feedPosition, 1);
});

test('duplicate repositories preserve source order and distinct serve positions', () => {
  const project = createFeedItemMapper();
  const one = item('duplicate', { serve_id: 'serve-a', position: 5 });
  const two = item('duplicate', { serve_id: 'serve-b', position: 0 });
  const result = project([{ items: [one, item('middle')] }, { items: [two] }]);
  assert.deepEqual(result.map(entry => [entry.repository.id, entry.repository.serveId, entry.repository.feedPosition]), [
    ['duplicate', 'serve-a', 5], ['middle', 'serve-1', 0], ['duplicate', 'serve-b', 0],
  ]);
  assert.equal(new Set(result.map(entry => entry.feedId)).size, 3);
});

test('reset and reordered refresh drop old cards and filter invalid records without offset drift', () => {
  const project = createFeedItemMapper();
  const first = item('first');
  const second = item('second');
  const invalid = item('invalid', { full_name: 'invalid' });
  project([{ items: [first, second] }]);
  assert.deepEqual(project(undefined), []);
  const refreshed = project([{ items: [invalid, second, first] }]);
  assert.deepEqual(refreshed.map(entry => entry.repository.id), ['second', 'first']);
  assert.equal(refreshed[0].feedId, 'serve-1:second:0');
  assert.equal(refreshed[1].feedId, 'serve-1:first:0');
  const otherViewer = createFeedItemMapper();
  assert.notStrictEqual(otherViewer([{ items: [first] }])[0].repository, project([{ items: [first] }])[0].repository);
});

 test('memoized discovery pages suppress overlap while retaining unchanged cards', () => {
  const project = createFeedItemMapper();
  const first = {mode: 'discovery' as const, items: [item('first')]};
  const before = project([first]);
  const after = project([first, {mode: 'discovery', items: [item('first'), item('second')]}]);
  assert.deepEqual(after.map(entry => entry.repository.id), ['first', 'second']);
  assert.strictEqual(after[0], before[0]);
});
