import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDateOfBirth, isValidDateOfBirth } from '../src/utils/date-of-birth';

const TODAY = new Date(2026, 6, 22, 12, 0, 0);

test('signup date of birth formatting and validation use calendar dates', () => {
  assert.equal(formatDateOfBirth(new Date(2000, 1, 29)), '2000-02-29');
  assert.equal(isValidDateOfBirth('2000-02-29', TODAY), true);
  assert.equal(isValidDateOfBirth('2001-02-29', TODAY), false);
  assert.equal(isValidDateOfBirth('2026-07-23', TODAY), false);
});
