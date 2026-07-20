import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareReadmeForDisplay, README_MAX_CHARACTERS } from '../src/utils/readme';

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
