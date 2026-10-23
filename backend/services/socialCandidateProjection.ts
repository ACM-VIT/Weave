/** Backend-only derivation from viewer-scoped authorized SQL rows.
 * This helper is not authorization: callers own visibility and signal permission.
 * Immutable owner IDs and distinct support are never guessed from handles.
 */
export type SocialSource = 'followed_owner' | 'followed_like' | 'followed_save'
  | 'co_like' | 'co_save' | 'board_topic' | 'adjacent_interest';
const sources = new Set<SocialSource>(['followed_owner', 'followed_like', 'followed_save',
  'co_like', 'co_save', 'board_topic', 'adjacent_interest']);
const collaborative = new Set<SocialSource>(['followed_like', 'followed_save', 'co_like', 'co_save', 'board_topic']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface SocialSignalRow {
  repo_id: string;
  owner_github_id: string | null;
  source: SocialSource;
  /** Stable namespaced source actor; never forwarded to ML. */
  actor_key: string;
  star_count: number;
  repo_status: string;
  viewer_can_access: boolean;
  actor_active: boolean;
  signal_allowed: boolean;
}
export interface SocialCandidateProjection {
  repo_id: string;
  owner_github_id: string;
  source: SocialSource;
  support: number;
  source_score: number;
}
export interface SocialProjectionOptions {
  maxCandidates?: number;
  maxPerOwner?: number;
  maxPerSource?: number;
  minimumCollaborativeSupport?: number;
}
export function projectSocialCandidates(rows: readonly SocialSignalRow[], options: SocialProjectionOptions = {}): SocialCandidateProjection[] {
  if (rows.length > 10_000) throw new Error('Social source query exceeded its row budget.');
  const maximum = options.maxCandidates ?? 100;
  const perOwner = options.maxPerOwner ?? 2;
  const perSource = options.maxPerSource ?? 20;
  const minimum = options.minimumCollaborativeSupport ?? 2;
  for (const value of [maximum, perOwner, perSource, minimum]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error('Invalid social projection bound.');
  }
  if (minimum < 2) throw new Error('Collaborative evidence requires at least two supporters.');
  const groups = new Map<string, { repo: string; owner: string; source: SocialSource; stars: number; actors: Set<string> }>();
  const owners = new Map<string, string>();
  for (const row of rows) {
    if (row.repo_status !== 'active' || row.viewer_can_access !== true
      || row.actor_active !== true || row.signal_allowed !== true || row.owner_github_id === null) continue;
    if (!uuid.test(row.repo_id) || !sources.has(row.source)
      || !/^[1-9][0-9]{0,18}$/.test(row.owner_github_id) || BigInt(row.owner_github_id) > 9_223_372_036_854_775_807n
      || typeof row.actor_key !== 'string' || row.actor_key.length < 1 || row.actor_key.length > 128
      || !Number.isSafeInteger(row.star_count) || row.star_count < 0) throw new Error('Invalid canonical social source row.');
    const repo = row.repo_id.toLowerCase();
    const previousOwner = owners.get(repo);
    if (previousOwner !== undefined && previousOwner !== row.owner_github_id) throw new Error('Conflicting immutable social owner attribution.');
    owners.set(repo, row.owner_github_id);
    const key = `${repo}:${row.source}`;
    const existing = groups.get(key);
    if (existing && existing.stars !== row.star_count) throw new Error('Inconsistent social popularity snapshot.');
    const group = existing ?? { repo, owner: row.owner_github_id, source: row.source, stars: row.star_count, actors: new Set<string>() };
    group.actors.add(row.actor_key);
    groups.set(key, group);
  }
  const projected = [...groups.values()].filter(group => group.actors.size >= (collaborative.has(group.source) ? minimum : 1))
    .map(group => ({ repo_id: group.repo, owner_github_id: group.owner, source: group.source,
      support: group.actors.size,
      source_score: group.actors.size / (group.actors.size + 1) / Math.sqrt(1 + Math.log1p(group.stars)),
    })).sort((a, b) => b.source_score - a.source_score || b.support - a.support
      || a.repo_id.localeCompare(b.repo_id) || a.source.localeCompare(b.source));
  const ownerRepos = new Map<string, Set<string>>();
  const sourceCounts = new Map<SocialSource, number>();
  const selected: SocialCandidateProjection[] = [];
  for (const candidate of projected) {
    const repos = ownerRepos.get(candidate.owner_github_id) ?? new Set<string>();
    if (!repos.has(candidate.repo_id) && repos.size >= perOwner) continue;
    if ((sourceCounts.get(candidate.source) ?? 0) >= perSource) continue;
    selected.push(candidate);
    repos.add(candidate.repo_id);
    ownerRepos.set(candidate.owner_github_id, repos);
    sourceCounts.set(candidate.source, (sourceCounts.get(candidate.source) ?? 0) + 1);
    if (selected.length === maximum) break;
  }
  return selected;
}
