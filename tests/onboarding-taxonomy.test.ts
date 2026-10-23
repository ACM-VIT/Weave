import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { resolveOnboardingTaxonomy, type OnboardingTaxonomy } from '../src/utils/onboardingTaxonomy';

// Use the actual displayed taxonomy. Only image imports are replaced: SVG
// rendering is unrelated to the ID/label boundary and cannot run in Node.
async function displayedTaxonomy(): Promise<OnboardingTaxonomy> {
  const result = await build({
    entryPoints: [path.resolve('src/constants/onboarding.tsx')], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['react'],
    plugins: [{ name: 'taxonomy-image-boundary', setup(build) {
      build.onResolve({ filter: /^@\/assets\// }, args => ({ path: args.path, namespace: 'image' }));
      build.onLoad({ filter: /.*/, namespace: 'image' }, () => ({ contents: 'export default function Image(){return null;}' }));
    } }],
  });
  const target: { exports: Record<string, unknown> } = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    createRequire(path.resolve('package.json')), target, target.exports,
  );
  return { skills: target.exports.SKILL_CATEGORIES, interests: target.exports.INTEREST_CATEGORIES } as OnboardingTaxonomy;
}

test('actual UI category IDs resolve to canonical labels and remain separately attributable', async () => {
  const taxonomy = await displayedTaxonomy();
  const result = resolveOnboardingTaxonomy({
    skills: ['data', 'systems', 'data'], interests: ['machine learning', 'c++'],
    tech_stack: [' C++ ', 'React', 'React'],
  }, taxonomy);
  assert.deepEqual(result.skills, ['Data Engineering & AI/ML Pipelines', 'Systems & Embedded Programming']);
  assert.deepEqual(result.taxonomy_selections.skills.map(entry => entry.id), ['data', 'systems']);
  assert.deepEqual(result.interests, ['machine learning', 'c++']);
  assert.deepEqual(result.tech_stack, ['C++', 'React']);
  assert.equal(taxonomy.skills.find(entry => entry.id === 'data')?.title, result.skills[0]);
});

test('no selection is inferred and unknown or ambiguous IDs cannot become preferences', () => {
  const taxonomy = { skills: [{ id: 'data', title: 'Data Engineering' }], interests: [] };
  assert.deepEqual(resolveOnboardingTaxonomy({}, taxonomy), {
    taxonomy_selections: { skills: [], interests: [] }, skills: [], interests: [], tech_stack: [],
  });
  assert.throws(() => resolveOnboardingTaxonomy({ skills: ['invented'] }, taxonomy), /Unknown taxonomy/);
  assert.throws(() => resolveOnboardingTaxonomy({ interests: ['invented'] }, taxonomy), /Unknown taxonomy/);
  assert.throws(() => resolveOnboardingTaxonomy({}, {
    ...taxonomy, skills: [...taxonomy.skills, { id: 'data', title: 'Something Else' }],
  }), /Ambiguous taxonomy/);
  assert.throws(() => resolveOnboardingTaxonomy({ tech_stack: [' '] }, taxonomy), /nonempty technology/);
  assert.throws(() => resolveOnboardingTaxonomy({ skills: Array(51).fill('data') }, taxonomy), /at most 50/);
});
