import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOnboardingPayload,
  normalizeOnboardingSlug,
} from '../src/utils/onboarding-payload';

test('onboarding sends legacy topics and structured persona fields with valid slugs', () => {
  const payload = buildOnboardingPayload({
    bio: 'dev',
    interests: ['github actions', 'ci/cd', 'c++', 'github actions'],
    skills: ['web', 'devops'],
    tech_stack: ['Node.js'],
  });

  assert.deepEqual(payload.interests, ['github-actions', 'ci-cd', 'cpp']);
  assert.deepEqual(payload.skills, ['web-frontend-frameworks', 'devops-infrastructure-and-security']);
  assert.deepEqual(payload.tech_stack, ['node-js']);
  assert.deepEqual(payload.topics, [
    'github-actions', 'ci-cd', 'cpp', 'web-frontend-frameworks', 'devops-infrastructure-and-security', 'node-js',
  ]);
  assert.equal(payload.bio, 'dev');
  assert.deepEqual(payload.taxonomy_selections.skills.map(entry => entry.id), ['web', 'devops']);
  assert.equal(payload.taxonomy_selections.skills[0].label, 'Web / Frontend Frameworks');
});

test('onboarding normalization always produces the backend slug format', () => {
  assert.equal(normalizeOnboardingSlug('Machine Learning'), 'machine-learning');
  assert.equal(normalizeOnboardingSlug('  CI/CD  '), 'ci-cd');
  assert.match(normalizeOnboardingSlug('ASP.NET'), /^[a-z0-9][a-z0-9-]{0,49}$/);
});

test('onboarding rejects an oversized bio before making the completion request', () => {
  assert.throws(
    () => buildOnboardingPayload({ bio: 'x'.repeat(2001), interests: ['react'] }),
    /2000 characters/,
  );
});
