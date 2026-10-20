import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAVE_REVEAL_THRESHOLD,
  SAVE_REVEAL_WIDTH,
  getSaveRevealTranslation,
  shouldRevealSaveAction,
} from '../src/components/home/save-swipe-gesture';

test('a short or leftward swipe never reveals the Save action', () => {
  assert.equal(shouldRevealSaveAction(SAVE_REVEAL_THRESHOLD - 1, 0), false);
  assert.equal(shouldRevealSaveAction(-SAVE_REVEAL_THRESHOLD, 0), false);
});

test('a diagonal drag must be clearly horizontal before it reveals Save', () => {
  assert.equal(shouldRevealSaveAction(SAVE_REVEAL_THRESHOLD, 51), false);
  assert.equal(shouldRevealSaveAction(SAVE_REVEAL_THRESHOLD, 20), true);
});

test('the reveal translation only moves right and remains bounded', () => {
  assert.equal(getSaveRevealTranslation(-30), 0);
  assert.equal(getSaveRevealTranslation(40), 40);
  assert.equal(getSaveRevealTranslation(SAVE_REVEAL_WIDTH + 50), SAVE_REVEAL_WIDTH);
});

test('accidental motion never commits a Save reveal in either vertical direction', () => {
  for (let x = -20; x <= 20; x += 1) {
    for (const y of [-100, -20, -1, 0, 1, 20, 100]) {
      assert.equal(shouldRevealSaveAction(x, y), false);
    }
  }
  assert.equal(shouldRevealSaveAction(SAVE_REVEAL_THRESHOLD, -60), false);
});
