import crypto from 'node:crypto';

import type { RepositoryUpsert, TrendingSnapshotInput } from '../contracts/ingestion.v2.js';

interface GitHubOwner {
  id: number;
  login: string;
}

interface GitHubSearchRepository {
  id: number;
  node_id?: string;
  name: string;
  full_name: string;
  html_url: string;
  description?: string | null;
  owner: GitHubOwner;
  language?: string | null;
  topics?: string[];
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  archived?: boolean;
  fork?: boolean;
}

interface GitHubSearchResponse {
  items?: GitHubSearchRepository[];
}

interface GitHubReadmeResponse {
  content?: string;
  encoding?: string;
}

export interface GitHubTrendingOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  limit?: number;
  enrichmentConcurrency?: number;
  requestTimeoutMs?: number;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(newer: Date, olderIso: string): number {
  return Math.max(0, (newer.getTime() - Date.parse(olderIso)) / 86_400_000);
}

function deterministicSnapshotId(period: string): string {
  const bytes = crypto.createHash('sha256').update(`weave:github-trending:${period}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function candidateScore(repo: GitHubSearchRepository, now: Date): number {
  const ageDays = Math.max(1, daysBetween(now, repo.created_at));
  const pushedDays = daysBetween(now, repo.pushed_at);
  const starVelocity = repo.stargazers_count / Math.min(ageDays, 365);
  const freshness = Math.max(0, 14 - pushedDays) / 14;
  return Math.log1p(repo.stargazers_count) * 2
    + Math.log1p(repo.forks_count)
    + Math.log1p(starVelocity) * 5
    + freshness * 3;
}

function discoveryBand(repo: GitHubSearchRepository, now: Date): string {
  const ageDays = daysBetween(now, repo.created_at);
  const velocity = repo.stargazers_count / Math.max(1, ageDays);
  if (ageDays <= 90 && velocity >= 2) return 'breakout';
  if (ageDays <= 365 && velocity >= 0.5) return 'rising';
  return 'active';
}

async function mapConcurrent<T, R>(
  input: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(input.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (next < input.length) {
      const index = next++;
      output[index] = await mapper(input[index]);
    }
  }));
  return output;
}

export class GitHubTrendingIngestionService {
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;
  private readonly now: () => Date;
  private readonly limit: number;
  private readonly enrichmentConcurrency: number;
  private readonly requestTimeoutMs: number;

  constructor(options: GitHubTrendingOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.token ?? process.env.GITHUB_TOKEN ?? '';
    this.now = options.now ?? (() => new Date());
    this.limit = Math.min(100, Math.max(1, options.limit ?? 75));
    this.enrichmentConcurrency = Math.min(10, Math.max(1, options.enrichmentConcurrency ?? 5));
    this.requestTimeoutMs = Math.min(60_000, Math.max(1_000, options.requestTimeoutMs ?? 20_000));
  }

  private headers(): Record<string, string> {
    if (!this.token) throw new Error('GITHUB_TOKEN is required for trending ingestion.');
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'weave-trending-ingestion',
    };
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`GitHub trending ingestion failed with ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response.json() as Promise<T>;
  }

  private async search(query: string): Promise<GitHubSearchRepository[]> {
    const params = new URLSearchParams({ q: query, sort: 'stars', order: 'desc', per_page: '100' });
    const response = await this.request<GitHubSearchResponse>(`/search/repositories?${params.toString()}`);
    return (response.items ?? []).filter((repo) => !repo.archived && !repo.fork && Boolean(repo.owner?.id));
  }

  private async enrich(repo: GitHubSearchRepository, observedAt: string): Promise<RepositoryUpsert> {
    const owner = encodeURIComponent(repo.owner.login);
    const name = encodeURIComponent(repo.name);
    const [languages, readme] = await Promise.all([
      this.request<Record<string, number>>(`/repos/${owner}/${name}/languages`)
        .catch((): Record<string, number> => ({})),
      this.request<GitHubReadmeResponse>(`/repos/${owner}/${name}/readme`)
        .catch((): GitHubReadmeResponse => ({})),
    ]);
    const decodedReadme = readme.encoding === 'base64' && readme.content
      ? Buffer.from(readme.content.replace(/\s/g, ''), 'base64').toString('utf8').slice(0, 200_000)
      : null;
    const now = this.now();
    return {
      github_id: String(repo.id),
      github_node_id: repo.node_id ?? null,
      owner_github_id: String(repo.owner.id),
      full_name: repo.full_name,
      owner: repo.owner.login,
      name: repo.name,
      url: repo.html_url,
      description: repo.description ?? null,
      readme: decodedReadme,
      readme_length: decodedReadme?.length ?? 0,
      primary_language: repo.language ?? null,
      languages: Object.keys(languages),
      topics: repo.topics ?? [],
      star_count: repo.stargazers_count,
      fork_count: repo.forks_count,
      open_issues_count: repo.open_issues_count,
      pushed_days_ago: Math.floor(daysBetween(now, repo.pushed_at)),
      created_at: repo.created_at,
      updated_at: repo.updated_at,
      pushed_at: repo.pushed_at,
      discovery_category: 'github-trending',
      discovery_band: discoveryBand(repo, now),
      observed_at: observedAt,
    };
  }

  async buildSnapshot(): Promise<TrendingSnapshotInput> {
    const now = this.now();
    const observedAt = now.toISOString();
    const createdAfter = new Date(now.getTime() - 90 * 86_400_000);
    const pushedAfter = new Date(now.getTime() - 7 * 86_400_000);
    const queries = [
      `created:>=${isoDate(createdAfter)} pushed:>=${isoDate(pushedAfter)} stars:>=5 archived:false fork:false`,
      `pushed:>=${isoDate(pushedAfter)} stars:>=100 archived:false fork:false`,
    ];
    const candidates = (await Promise.all(queries.map((query) => this.search(query)))).flat();
    const unique = new Map<number, GitHubSearchRepository>();
    for (const repo of candidates) unique.set(repo.id, repo);
    const ranked = [...unique.values()]
      .map((repo) => ({ repo, score: candidateScore(repo, now) }))
      .sort((a, b) => b.score - a.score || b.repo.stargazers_count - a.repo.stargazers_count)
      .slice(0, this.limit);
    if (ranked.length === 0) throw new Error('GitHub returned no eligible trending repositories.');
    const enriched = await mapConcurrent(
      ranked,
      this.enrichmentConcurrency,
      async ({ repo, score }) => ({ repo: await this.enrich(repo, observedAt), score }),
    );
    const period = `github-daily-${isoDate(now)}`;
    return {
      snapshot_id: deterministicSnapshotId(period),
      period: 'daily',
      computed_at: observedAt,
      source: 'github-search-persona-corpus-v1',
      repositories: enriched.map(({ repo, score }, rank) => ({ ...repo, rank, score })),
    };
  }
}
