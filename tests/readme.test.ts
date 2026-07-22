import assert from 'node:assert/strict';
import test from 'node:test';

import {
  prepareReadmeForDisplay,
  prepareReadmePreview,
  README_MAX_CHARACTERS,
} from '../src/utils/readme';

test('README display uses a safe fallback for empty input', () => {
  assert.equal(
    prepareReadmeForDisplay('  '),
    'No README content is available for this repository.',
  );
});

test('README display bounds untrusted repository content', () => {
  const prepared = prepareReadmeForDisplay('x'.repeat(README_MAX_CHARACTERS + 100));
  assert.equal(prepared.startsWith('x'.repeat(README_MAX_CHARACTERS)), true);
  assert.equal(prepared.endsWith('[README truncated for safe display]'), true);
});

test('README preview prefers the summary and trims surrounding whitespace', () => {
  assert.deepEqual(
    prepareReadmePreview('  **Focused summary**  ', 'Full README'),
    { isTruncated: false, markdown: '**Focused summary**' },
  );
});

test('README preview falls back to full content and then an empty state', () => {
  assert.deepEqual(
    prepareReadmePreview(' ', '  # Full README  '),
    { isTruncated: false, markdown: '# Full README' },
  );
  assert.deepEqual(
    prepareReadmePreview(null, undefined),
    { isTruncated: false, markdown: 'No summary available.' },
  );
});

test('README preview truncates at a natural boundary and reports overflow', () => {
  const prepared = prepareReadmePreview(
    'A polished introduction with useful context. A second sentence should not be split awkwardly. Extra detail follows here.',
    null,
    100,
  );

  assert.equal(prepared.isTruncated, true);
  assert.equal(prepared.markdown.endsWith('\n\n\u2026'), true);
  assert.equal(prepared.markdown.includes('awkwardly'), true);
  assert.equal(prepared.markdown.includes('Extra detail'), false);
});

test('README preview closes a truncated fenced code block', () => {
  const prepared = prepareReadmePreview(
    `\`\`\`ts\n${'const value = example();\n'.repeat(10)}\`\`\``,
    null,
    90,
  );
  const fences = prepared.markdown.match(/^\`\`\`/gm) ?? [];

  assert.equal(prepared.isTruncated, true);
  assert.equal(fences.length, 2);
  assert.equal(prepared.markdown.endsWith('\n\n\u2026'), true);
});

test('README preview never leaves a dangling emoji surrogate', () => {
  const prepared = prepareReadmePreview(`abcd\ud83d\ude80 more content`, null, 5);
  const contentBeforeMarker = prepared.markdown.split('\n\n')[0];
  const finalCodeUnit = contentBeforeMarker.charCodeAt(contentBeforeMarker.length - 1);

  assert.equal(finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff, false);
});
