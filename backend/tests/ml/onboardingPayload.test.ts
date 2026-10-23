import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMlOnboardingJob,
  hasMlEmbeddingContext,
  isObsoleteIdentityOnboardingJob,
} from '../../services/mlOnboardingService.js';

test('ML onboarding preserves and normalizes distinct profile categories', () => {
  const job = buildMlOnboardingJob(
    '00000000-0000-4000-8000-000000000001',
    3,
    {
      username: 'weave-user',
      bio: 'Recommendation systems',
      interests: [' machine-learning ', 'machine-learning'],
      skills: ['typescript'],
      techStack: ['postgresql'],
    },
    '00000000-0000-4000-8000-000000000002',
  );
  assert.deepEqual(job.profile.interests, ['machine-learning']);
  assert.deepEqual(job.profile.skills, ['typescript']);
  assert.deepEqual(job.profile.tech_stack, ['postgresql']);
  assert.equal(hasMlEmbeddingContext(job.profile), true);
});

test('identity-only onboarding is deferred and can be classified as obsolete', () => {
  const job = buildMlOnboardingJob(
    '00000000-0000-4000-8000-000000000001',
    1,
    { username: 'weave-user', fullName: 'Weave User' },
    '00000000-0000-4000-8000-000000000002',
  );
  assert.equal(hasMlEmbeddingContext(job.profile), false);
  assert.equal(isObsoleteIdentityOnboardingJob(job as unknown as Record<string, unknown>), true);
  assert.equal(isObsoleteIdentityOnboardingJob({ ...job, profile_version: 2 } as unknown as Record<string, unknown>), false);
  assert.equal(isObsoleteIdentityOnboardingJob({
    ...job, profile: { ...job.profile, interests: ['typescript'] },
  } as unknown as Record<string, unknown>), false);
});

test('legacy UI skill IDs become canonical semantic names in every ML job', () => {
  const job = buildMlOnboardingJob('00000000-0000-4000-8000-000000000001', 2, {
    username: 'Tarun', skills: ['data', 'systems'],
  });
  assert.deepEqual(job.profile.skills, ['Data Engineering & AI/ML Pipelines', 'Systems & Embedded Programming']);
});

test('ML onboarding normalizes blank optional identity strings to null', () => {
  const job = buildMlOnboardingJob(
    '00000000-0000-4000-8000-000000000001',
    2,
    {
      username: '   ', fullName: '\t', githubUsername: '', avatarUrl: '  ',
      bio: ' ', interests: ['typescript'],
    },
    '00000000-0000-4000-8000-000000000002',
  );
  assert.equal(job.profile.username, null);
  assert.equal(job.profile.full_name, null);
  assert.equal(job.profile.github_username, null);
  assert.equal(job.profile.avatar_url, null);
  assert.equal(job.profile.bio, null);
  assert.equal(hasMlEmbeddingContext(job.profile), true);
});
