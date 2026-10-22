import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeDescription } from '../../services/summaryService.js';

test('legacy description fallback is bounded and never derives from README content', () => {
  assert.equal(summarizeDescription(null), null);
  assert.equal(summarizeDescription('  A focused repository.  '), 'A focused repository.');
  const bounded = summarizeDescription(`Useful project ${'context '.repeat(80)}`);
  assert.ok(bounded);
  assert.ok(bounded.length <= 360);
  assert.ok(bounded.endsWith('…'));
});
