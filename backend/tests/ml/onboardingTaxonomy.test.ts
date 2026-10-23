import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOnboardingTaxonomy, canonicalSkillNames } from '../../services/onboardingTaxonomy.js';
import { normalizeOnboardingTopic } from '../../contracts/onboardingTaxonomy.js';

test('server derives only canonical known labels and retains stable IDs', () => {
  const result = validateOnboardingTaxonomy({ version: 1,
    skills: [{ id: 'data', label: 'Data Engineering & AI/ML Pipelines' }],
    interests: [{ id: 'c++', label: 'c++' }],
  });
  assert.equal(result?.skills[0].id, 'data');
  assert.equal(result?.skills[0].label, 'Data Engineering & AI/ML Pipelines');
  assert.equal(normalizeOnboardingTopic(result!.interests[0].label), 'cpp');
  assert.deepEqual(canonicalSkillNames(['web', 'custom skill']), ['Web / Frontend Frameworks', 'custom skill']);
  assert.equal(validateOnboardingTaxonomy(undefined), null, 'legacy clients remain compatible');
});

test('forged taxonomy versions, IDs or names cannot enter the profile', () => {
  for (const value of [null, [], {}, { version: 2, skills: [], interests: [] },
    { version: 1, skills: [{ id: 'data', label: 'fake' }], interests: [] },
    { version: 1, skills: [{ id: 'fake', label: 'fake' }], interests: [] },
  ]) assert.throws(() => validateOnboardingTaxonomy(value), /Invalid onboarding/);
});
