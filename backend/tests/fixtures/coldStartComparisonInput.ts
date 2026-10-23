import type { ColdStartContextInput } from '../../services/coldStartContextExport.js';
// Source-shaped isolated synthetic context, not a real user's GitHub history.
export const coldStartComparisonInput: ColdStartContextInput = {
  schema_version: 1, profile_id: '00000000-0000-4000-8000-000000000001', source_kind: 'controlled_fixture',
  cutoff: '2026-10-23T01:00:00Z', manual_collected_at: '2026-10-22T00:00:00Z', github_consent_at: '2026-10-23T00:00:00Z',
  manual: { username: 'Tarun', bio: 'Database engineering', interests: ['postgresql'], skills: ['data'], techStack: ['Rust'] },
  github: { github_id: '7', github_handle: 'fixture', collected_at: '2026-10-23T00:01:00Z', status: 'complete',
    repositories: [{ github_id: '8', owner_github_id: '7', owner: 'fixture', name: 'repo', full_name: 'fixture/repo',
        url: 'https://github.com/fixture/repo', description: null, primary_language: 'TypeScript', topics: ['react'],
        updated_at: '2026-10-20T00:00:00Z', fork: false, star_count: 1, fork_count: 0, open_issues_count: 0, sources: ['owned'] }],
    sources: { owned: { status: 'complete', count: 1, pages: 1 }, starred: { status: 'complete', count: 0, pages: 1 }, contributed: { status: 'complete', count: 0, pages: 1 } } },
};
