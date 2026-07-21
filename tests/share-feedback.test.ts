import assert from 'node:assert/strict';
import test from 'node:test';

import { shareResultConfirmsCompletion } from '../src/utils/share-feedback';

test('share feedback is recorded only when iOS can distinguish completion from dismissal', () => {
  assert.equal(shareResultConfirmsCompletion('ios', 'sharedAction', 'sharedAction'), true);
  assert.equal(shareResultConfirmsCompletion('ios', 'dismissedAction', 'sharedAction'), false);
  assert.equal(shareResultConfirmsCompletion('android', 'sharedAction', 'sharedAction'), false);
  assert.equal(shareResultConfirmsCompletion('web', 'sharedAction', 'sharedAction'), false);
});
