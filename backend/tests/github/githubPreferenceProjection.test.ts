import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeImportedPreferences } from '../../services/githubPreferenceProjection.js';
import { canonicalSkillNames } from '../../services/onboardingTaxonomy.js';

test('legacy manual skill IDs and imported canonical names share one preference identity', () => {
  const baseline = { interests: ['manual'], skills: ['web', 'devops'], tech_stack: ['rust'] };
  const result = mergeImportedPreferences(baseline, {
    interests: ['typescript'], skills: ['Web / Frontend Frameworks', 'DevOps, Infrastructure & Security'], tech_stack: ['rust'],
  });
  assert.deepEqual(result.skills, baseline.skills, 'manual representations remain owned by the user');
  assert.equal(new Set(canonicalSkillNames(result.skills)).size, result.skills.length);
  assert.deepEqual(result.interests, ['manual', 'typescript']);
  assert.deepEqual(baseline.skills, ['web', 'devops']);
});
