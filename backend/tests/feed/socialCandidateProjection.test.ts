import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSocialCandidates, type SocialSignalRow } from '../../services/socialCandidateProjection.js';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
function row(n: number, patch: Partial<SocialSignalRow> = {}): SocialSignalRow {
  return { repo_id: id(n), owner_github_id: '123', source: 'followed_owner', actor_key: 'registered:actor1',
    star_count: 10, repo_status: 'active', viewer_can_access: true, actor_active: true, signal_allowed: true, ...patch };
}
test('social evidence requires current visibility, active actors and an immutable owner', () => {
  const rows = [row(1), row(2, { viewer_can_access: false }), row(3, { signal_allowed: false, source: 'board_topic' }),
    row(4, { actor_active: false }), row(5, { repo_status: 'deleted' }), row(6, { owner_github_id: null })];
  assert.deepEqual(projectSocialCandidates(rows).map(r => r.repo_id), [id(1)]);
});
test('support counts distinct source actors and never exposes their identities', () => {
  const rows = [row(1, { source: 'co_save' }), row(1, { source: 'co_save' })];
  assert.deepEqual(projectSocialCandidates(rows), []);
  rows.push(row(1, { source: 'co_save', actor_key: 'registered:actor2' }));
  const result = projectSocialCandidates(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].support, 2);
  assert.deepEqual(Object.keys(result[0]).sort(), ['owner_github_id','repo_id','source','source_score','support']);
});
test('popularity normalization and deterministic quotas prevent owner/source domination', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, { owner_github_id: i < 10 ? '1' : String(i + 1) }));
  const a = projectSocialCandidates(rows, { maxCandidates: 5, maxPerSource: 5 });
  const b = projectSocialCandidates([...rows].reverse(), { maxCandidates: 5, maxPerSource: 5 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 5);
  assert.equal(a.filter(r => r.owner_github_id === '1').length, 2);
  const popularity = projectSocialCandidates([row(1, { star_count: 100000 }), row(2, { star_count: 1 })]);
  assert.equal(popularity[0].repo_id, id(2));
  assert.ok(popularity.every(r => r.source_score > 0 && r.source_score <= 1));
});
test('malformed or conflicting canonical evidence fails instead of guessing handles', () => {
  assert.throws(() => projectSocialCandidates([row(1, { owner_github_id: 'handle' })]), /canonical/);
  assert.throws(() => projectSocialCandidates([row(1), row(1, { owner_github_id: '456', source: 'adjacent_interest' })]), /Conflicting/);
  assert.throws(() => projectSocialCandidates([row(1), row(1, { star_count: 11 })]), /snapshot/);
  assert.throws(() => projectSocialCandidates([row(1, { star_count: NaN })]), /canonical/);
  assert.throws(() => projectSocialCandidates([], { minimumCollaborativeSupport: 1 }), /two/);
  assert.throws(() => projectSocialCandidates(Array.from({ length: 10001 }, () => row(1))), /budget/);
});
