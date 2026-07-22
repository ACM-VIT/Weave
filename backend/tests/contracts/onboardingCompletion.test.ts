import assert from 'node:assert/strict';
import test from 'node:test';

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
});

const [{ hasCompletedOnboarding }, { sqlClient }] = await Promise.all([
  import('../../controllers/productV2Controller.js'),
  import('../../db/index.js'),
]);

test.after(async () => {
  await sqlClient.end({ timeout: 0 });
});

test('onboarding completion uses only the explicit durable flag', () => {
  assert.equal(hasCompletedOnboarding(true), true);
  assert.equal(hasCompletedOnboarding(false), false);
});

test('missing completion state fails closed', () => {
  assert.equal(hasCompletedOnboarding(undefined), false);
  assert.equal(hasCompletedOnboarding(null), false);
});
