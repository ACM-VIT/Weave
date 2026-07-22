import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidDateOfBirth } from '../../utils/dateOfBirth.js';

const TODAY = new Date('2026-07-22T12:00:00.000Z');

test('date of birth validation accepts a real non-future calendar date', () => {
  assert.equal(isValidDateOfBirth('2000-02-29', TODAY), true);
  assert.equal(isValidDateOfBirth('2026-07-22', TODAY), true);
});

test('date of birth validation rejects missing, impossible, future, and implausibly old values', () => {
  assert.equal(isValidDateOfBirth(undefined, TODAY), false);
  assert.equal(isValidDateOfBirth('2001-02-29', TODAY), false);
  assert.equal(isValidDateOfBirth('2026-07-23', TODAY), false);
  assert.equal(isValidDateOfBirth('1899-12-31', TODAY), false);
  assert.equal(isValidDateOfBirth('22-07-2000', TODAY), false);
});
