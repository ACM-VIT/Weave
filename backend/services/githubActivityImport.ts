export type GitHubActivitySource = 'owned' | 'starred' | 'contributed';
export interface GitHubActivityRepository {
  github_id: string;
  owner_github_id: string;
  full_name: string;
  owner: string;
  name: string;
  url: string;
  description: string | null;
  primary_language: string | null;
  topics: string[];
  updated_at: string;
  star_count: number;
  fork_count: number;
  open_issues_count: number;
  fork: boolean;
  sources: GitHubActivitySource[];
}
export interface GitHubActivitySourceResult {
  status: 'complete' | 'truncated' | 'unavailable';
  pages: number;
  count: number;
  error_code?: string;
  retry_after_seconds?: number;
}
export interface GitHubActivitySnapshot {
  github_id: string;
  github_handle: string;
  collected_at: string;
  status: 'complete' | 'partial';
  repositories: GitHubActivityRepository[];
  sources: Record<GitHubActivitySource, GitHubActivitySourceResult>;
}

export class GitHubActivityImportError extends Error {
  constructor(readonly code: string, readonly retryAfterSeconds?: number) {
    super(code);
    this.name = 'GitHubActivityImportError';
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubActivityImportError('invalid_response');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new GitHubActivityImportError('invalid_response');
  return value;
}
function numericId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
    && BigInt(value) <= 9_223_372_036_854_775_807n) return value;
  throw new GitHubActivityImportError('invalid_numeric_identity');
}
function integer(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error('Invalid GitHub import resource limit.');
  return result;
}
function publicRepository(value: unknown, source: GitHubActivitySource): GitHubActivityRepository | null {
  const row = object(value);
  const graphql = source === 'contributed';
  // A privileged credential is never permission to import private/internal data.
  if ((graphql ? row.isPrivate : row.private) !== false
    || (row.visibility !== undefined && String(row.visibility).toLowerCase() !== 'public')) return null;
  const owner = object(row.owner);
  const fullName = text(graphql ? row.nameWithOwner : row.full_name, 250);
  const ownerName = text(owner.login, 100);
  const name = text(row.name, 100);
  if (fullName.toLowerCase() !== `${ownerName}/${name}`.toLowerCase()
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new GitHubActivityImportError('invalid_response');
  const url = text(graphql ? row.url : row.html_url, 500);
  if (url.toLowerCase() !== `https://github.com/${fullName}`.toLowerCase()) throw new GitHubActivityImportError('invalid_response');
  const rawTopics = graphql
    ? object(row.repositoryTopics).nodes
    : row.topics;
  if (!Array.isArray(rawTopics) || rawTopics.length > 100) throw new GitHubActivityImportError('invalid_response');
  const topics = rawTopics.map(entry => text(graphql ? object(object(entry).topic).name : entry, 100));
  const language = graphql ? row.primaryLanguage == null ? null : object(row.primaryLanguage).name : row.language;
  const updatedAt = text(graphql ? row.updatedAt : row.updated_at, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(updatedAt)
    || !Number.isFinite(Date.parse(updatedAt))) throw new GitHubActivityImportError('invalid_response');
  if (typeof (graphql ? row.isFork : row.fork) !== 'boolean') throw new GitHubActivityImportError('invalid_response');
  const count = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new GitHubActivityImportError('invalid_response');
    return value;
  };
  return {
    github_id: numericId(graphql ? row.databaseId : row.id),
    owner_github_id: numericId(graphql ? owner.databaseId : owner.id),
    full_name: fullName, owner: ownerName, name, url,
    description: row.description == null || row.description === '' ? null : text(row.description, 10_000),
    primary_language: language == null ? null : text(language, 100),
    topics: [...new Set(topics)], updated_at: updatedAt, fork: (graphql ? row.isFork : row.fork) as boolean,
    star_count: count(graphql ? row.stargazerCount : row.stargazers_count),
    fork_count: count(graphql ? row.forkCount : row.forks_count),
    open_issues_count: count(graphql ? object(row.issues).totalCount : row.open_issues_count),
    sources: [source],
  };
}

export class GitHubActivityImportClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxBodyBytes: number;

  constructor(private readonly options: {
    token: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    pageSize?: number;
    maxPages?: number;
    maxBodyBytes?: number;
  }) {
    if (!options.token.trim()) throw new Error('GitHub import requires a configured service credential.');
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = integer(options.timeoutMs, 8_000, 60_000);
    this.pageSize = integer(options.pageSize, 100, 100);
    this.maxPages = integer(options.maxPages, 3, 5);
    this.maxBodyBytes = integer(options.maxBodyBytes, 2_097_152, 8_388_608);
  }

  private async request(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const retry = Number(response.headers.get('retry-after'));
      throw new GitHubActivityImportError(response.status === 403 || response.status === 429 ? 'rate_limited' : 'provider_unavailable',
        Number.isFinite(retry) && retry > 0 ? Math.min(Math.ceil(retry), 3_600) : undefined);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new GitHubActivityImportError('invalid_response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > this.maxBodyBytes) throw new GitHubActivityImportError('response_too_large');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new GitHubActivityImportError('invalid_response'); }
  }

  async collect(identity: { githubId: string; handle: string }, signal?: AbortSignal): Promise<GitHubActivitySnapshot> {
    const githubId = numericId(identity.githubId);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(identity.handle)) {
      throw new GitHubActivityImportError('invalid_handle');
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    timer.unref();
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      const profile = object(await this.request(`/users/${encodeURIComponent(identity.handle)}`, combined));
      if (numericId(profile.id) !== githubId) throw new GitHubActivityImportError('provider_identity_changed');
      const handle = text(profile.login, 100);
      if (handle.toLowerCase() !== identity.handle.toLowerCase()) throw new GitHubActivityImportError('provider_identity_changed');
      const repositories = new Map<string, GitHubActivityRepository>();
      const sources = {} as GitHubActivitySnapshot['sources'];
      for (const source of ['owned', 'starred', 'contributed'] as const) {
        const result: GitHubActivitySourceResult = { status: 'complete', pages: 0, count: 0 };
        const sourceIds = new Set<string>();
        let cursor: string | null = null;
        const cursors = new Set<string>();
        try {
          for (let page = 1; page <= this.maxPages; page++) {
            combined.throwIfAborted();
            let rows: unknown[];
            let hasNext: boolean;
            if (source === 'contributed') {
              const payload = object(await this.request('/graphql', combined, {
                query: `query PublicContributions($handle:String!,$first:Int!,$after:String){user(login:$handle){databaseId repositoriesContributedTo(first:$first,after:$after,privacy:PUBLIC,includeUserRepositories:false,contributionTypes:[COMMIT,ISSUE,PULL_REQUEST]){nodes{databaseId name nameWithOwner url description updatedAt isPrivate visibility isFork stargazerCount forkCount issues(states:OPEN){totalCount} owner{login ... on User{databaseId} ... on Organization{databaseId}} primaryLanguage{name} repositoryTopics(first:20){nodes{topic{name}}}} pageInfo{hasNextPage endCursor}}}}`,
                variables: { handle, first: this.pageSize, after: cursor },
              }));
              if (payload.errors !== undefined) throw new GitHubActivityImportError('provider_query_failed');
              const user = object(object(payload.data).user);
              if (numericId(user.databaseId) !== githubId) throw new GitHubActivityImportError('provider_identity_changed');
              const connection = object(user.repositoriesContributedTo);
              if (!Array.isArray(connection.nodes)) throw new GitHubActivityImportError('invalid_response');
              rows = connection.nodes;
              const pageInfo = object(connection.pageInfo);
              if (typeof pageInfo.hasNextPage !== 'boolean') throw new GitHubActivityImportError('invalid_response');
              hasNext = pageInfo.hasNextPage;
              if (hasNext) {
                cursor = text(pageInfo.endCursor, 2_000);
                if (cursors.has(cursor)) throw new GitHubActivityImportError('repeated_cursor');
                cursors.add(cursor);
              }
            } else {
              const endpoint = source === 'owned' ? 'repos?type=owner&sort=updated&direction=desc' : 'starred?sort=created&direction=desc';
              const payload = await this.request(`/users/${encodeURIComponent(handle)}/${endpoint}&per_page=${this.pageSize}&page=${page}`, combined);
              if (!Array.isArray(payload)) throw new GitHubActivityImportError('invalid_response');
              rows = payload;
              hasNext = rows.length === this.pageSize;
            }
            if (rows.length > this.pageSize) throw new GitHubActivityImportError('invalid_response');
            const accepted = rows.map(row => publicRepository(row, source)).filter((row): row is GitHubActivityRepository => row !== null);
            const pageIdentities = new Map<string, GitHubActivityRepository>();
            for (const row of accepted) {
              if (source === 'owned' && row.owner_github_id !== githubId) throw new GitHubActivityImportError('invalid_owned_repository');
              const existing = pageIdentities.get(row.github_id) ?? repositories.get(row.github_id);
              if (existing && existing.owner_github_id !== row.owner_github_id) throw new GitHubActivityImportError('conflicting_repository_identity');
              pageIdentities.set(row.github_id, row);
            }
            for (const row of accepted) {
              const existing = repositories.get(row.github_id);
              if (existing) { if (!existing.sources.includes(source)) existing.sources.push(source); }
              else repositories.set(row.github_id, row);
              sourceIds.add(row.github_id);
            }
            result.pages++;
            if (!hasNext) break;
            if (page === this.maxPages) result.status = 'truncated';
          }
        } catch (error) {
          result.status = 'unavailable';
          result.error_code = combined.aborted ? signal?.aborted ? 'cancelled' : 'deadline_exceeded'
            : error instanceof GitHubActivityImportError ? error.code : 'transport_error';
          if (error instanceof GitHubActivityImportError && error.retryAfterSeconds !== undefined) {
            result.retry_after_seconds = error.retryAfterSeconds;
          }
        }
        result.count = sourceIds.size;
        sources[source] = result;
      }
      return { github_id: githubId, github_handle: handle, collected_at: new Date().toISOString(),
        status: Object.values(sources).every(source => source.status === 'complete') ? 'complete' : 'partial',
        repositories: [...repositories.values()], sources };
    } catch (error) {
      if (combined.aborted) throw new GitHubActivityImportError(signal?.aborted ? 'cancelled' : 'deadline_exceeded');
      throw error;
    } finally { clearTimeout(timer); }
  }
}
