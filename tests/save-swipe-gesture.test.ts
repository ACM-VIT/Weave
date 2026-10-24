import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAVE_SWIPE_THRESHOLD,
  shouldOpenSavePicker,
} from '../src/components/home/save-swipe-gesture';

test('a short or leftward swipe never opens the List picker', () => {
  assert.equal(shouldOpenSavePicker(SAVE_SWIPE_THRESHOLD - 1, 0), false);
  assert.equal(shouldOpenSavePicker(-SAVE_SWIPE_THRESHOLD, 0), false);
});

test('a diagonal drag must be clearly horizontal before it opens the List picker', () => {
  assert.equal(shouldOpenSavePicker(SAVE_SWIPE_THRESHOLD, 51), false);
  assert.equal(shouldOpenSavePicker(SAVE_SWIPE_THRESHOLD, 20), true);
});

test('accidental motion never commits a List picker in either vertical direction', () => {
  for (let x = -20; x <= 20; x += 1) {
    for (const y of [-100, -20, -1, 0, 1, 20, 100]) {
      assert.equal(shouldOpenSavePicker(x, y), false);
    }
  }
  assert.equal(shouldOpenSavePicker(SAVE_SWIPE_THRESHOLD, -60), false);
});
