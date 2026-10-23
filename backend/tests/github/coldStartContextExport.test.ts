import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportColdStartContexts, type ColdStartContextInput } from '../../services/coldStartContextExport.js';

const input: ColdStartContextInput = {
  schema_version: 1, profile_id: '00000000-0000-4000-8000-000000000001', source_kind: 'controlled_fixture',
  cutoff: '2026-10-23T01:00:00Z', manual_collected_at: '2026-10-22T00:00:00Z', github_consent_at: '2026-10-23T00:00:00Z',
  manual: { username: 'Tarun', bio: 'Database engineering', interests: ['postgresql'], skills: ['data'], techStack: ['Rust'] },
  github: { github_id: '7', github_handle: 'fixture', collected_at: '2026-10-23T00:01:00Z', status: 'complete',
    repositories: [{ github_id: '8', owner_github_id: '7', owner: 'fixture', name: 'repo', full_name: 'fixture/repo',
      url: 'https://github.com/fixture/repo', description: null, primary_language: 'TypeScript', topics: ['react'],
      updated_at: '2026-10-20T00:00:00Z', fork: false, star_count: 1, fork_count: 0, open_issues_count: 0, sources: ['owned'] }],
    sources: { owned: { status: 'complete', count: 1, pages: 1 }, starred: { status: 'complete', count: 0, pages: 1 }, contributed: { status: 'complete', count: 0, pages: 1 } } },
};

test('comparison exports actual manual/imported/combined projection with distinct provenance, never fake quality labels', () => {
  const output = exportColdStartContexts(input);
  assert.equal(output.evaluation_ready, false);
  assert.equal(output.source_kind, 'controlled_fixture');
  assert.deepEqual(output.variants.map(row => row.variant), ['onboarding_only', 'github_only', 'combined']);
  assert.equal(new Set(output.variants.map(row => row.profile_id)).size, 1, 'same frozen evaluation identity across variants');
  assert.equal(new Set(output.variants.map(row => row.context_sha256)).size, 3);
  assert.deepEqual(output.variants[0].profile.skills, ['Data Engineering & AI/ML Pipelines']);
  assert.deepEqual(output.variants[1].profile.skills, ['Web / Frontend Frameworks']);
  assert.equal(output.variants[1].profile.bio, null, 'GitHub-only cannot borrow manual semantic context');
  assert.deepEqual(output.variants[2].profile.interests, ['postgresql', 'react']);
  assert.ok(output.variants.every(row => row.has_embedding_context));
  assert.equal(output.variants[0].provenance.github_sources, null);
  assert.deepEqual(output, exportColdStartContexts(input), 'context manifest is deterministic');
});

test('future observations and consent-after-collection are rejected; empty GitHub data stays unprepared', () => {
  assert.throws(() => exportColdStartContexts({ ...input, cutoff: '2026-10-22T01:00:00Z' }), /point-in-time/);
  assert.throws(() => exportColdStartContexts({ ...input, github_consent_at: input.cutoff }), /consent/);
  const empty = exportColdStartContexts({ ...input, github: { ...input.github, repositories: [] } });
  assert.equal(empty.variants[1].has_embedding_context, false);
  assert.equal(empty.evaluation_ready, false);
});

test('private CLI exports without database configuration or overwriting an existing artifact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'weave-context-export-'));
  try {
    const source = path.join(directory, 'input.json'), output = path.join(directory, 'contexts.json');
    await writeFile(source, JSON.stringify(input));
    const args = ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('scripts/export-cold-start-contexts.ts'), '--input', source, '--output', output];
    const options = { cwd: directory, env: { ...process.env, DATABASE_URL: '' }, encoding: 'utf8' as const, stdio: 'pipe' as const };
    assert.match(execFileSync(process.execPath, args, options), /evaluation_ready=false/);
    const raw = await readFile(output, 'utf8');
    assert.equal(JSON.parse(raw).variants.length, 3);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.throws(() => execFileSync(process.execPath, args, options), /EEXIST/);
    assert.equal(await readFile(output, 'utf8'), raw);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
