import crypto from 'node:crypto';
import { isValidUuid } from '../utils/validators.js';
import { checkSearchWork, createSearchWork, settleSearchWork, type SearchWork } from './searchWork.js';

export type SearchGroup = 'all' | 'repositories' | 'people' | 'lists';
export type SearchFilters = { languages: string[]; topics: string[] };
export type SearchRequest = {
  schema_version: 2; search_id: string; query: string; group: SearchGroup; limit: number;
  exclude_repo_ids: string[]; filters: SearchFilters; cursor: string | null;
};
export type SearchRef = { type: 'repository' | 'person' | 'list'; id: string };
export type SearchResult = SearchRef & { data: Record<string, unknown> };
export interface SearchPersistence {
  lexical(request: SearchRequest, work?: SearchWork): Promise<{ id: string; exact: boolean }[]>;
  people(request: SearchRequest, work?: SearchWork): Promise<SearchRef[]>;
  lists(viewer: string, request: SearchRequest, work?: SearchWork): Promise<SearchRef[]>;
  hydrate(viewer: string, refs: SearchRef[], request: SearchRequest, work?: SearchWork): Promise<SearchResult[]>;
}
export class SearchInputError extends Error { readonly statusCode = 400; }
export class SearchExpiredError extends Error { readonly statusCode = 410; }

export type SearchSnapshot = { binding: string; refs: SearchRef[]; mode: 'hybrid' | 'lexical'; expires: number };
export interface SearchSnapshotStore {
  get(key: string): Promise<SearchSnapshot | undefined>;
  set(key: string, snapshot: SearchSnapshot): Promise<void>;
  getOrCreate?(binding: string, viewer: string, build: (signal?: AbortSignal) => Promise<SearchSnapshot>, signal?: AbortSignal): Promise<{ key: string; snapshot: SearchSnapshot }>;
}
export class SearchRateLimitError extends Error { readonly statusCode = 429; }

// Three times the missing slots amortizes rejected rows; the floor also bounds
// serial top-ups for small pages. A normal snapshot has at most 400 references
// (200 merged repositories, 100 people, 100 Lists).
const HYDRATION_MIN_WINDOW = 24;
const HYDRATION_MAX_WINDOW = 100;
const HYDRATION_PAGE_BUDGET = 400;

/** Local store for isolated tests. The HTTP controller supplies shared Redis storage. */
export class MemorySearchSnapshotStore implements SearchSnapshotStore {
  private readonly snapshots = new Map<string, SearchSnapshot>();
  async get(key: string) { return this.snapshots.get(key); }
  async set(key: string, snapshot: SearchSnapshot) {
    if (this.snapshots.size >= 256) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(key, snapshot);
  }
}

export function parseSearchRequest(body: unknown): SearchRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SearchInputError('Invalid search request.');
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !['schema_version','search_id','query','group','limit','exclude_repo_ids','filters','cursor'].includes(k))) throw new SearchInputError('Unsupported search field.');
  const query = typeof b.query === 'string' ? b.query.trim() : '';
  const filters = (b.filters ?? {}) as Record<string, unknown>;
  const group = b.group === undefined ? 'all' : b.group;
  const limit = b.limit ?? 24;
  const exclusions = b.exclude_repo_ids ?? [];
  const strings = (value: unknown, max: number, topic = false): value is string[] => Array.isArray(value)
    && value.length <= 10 && value.every(v => typeof v === 'string' && v === v.trim() && v.length >= 1 && v.length <= max && (!topic || /^[a-z0-9][a-z0-9-]*$/.test(v)));
  if (b.schema_version !== 2 || typeof b.search_id !== 'string' || !isValidUuid(b.search_id)
    || query.length < 2 || query.length > 512 || typeof group !== 'string' || !['all','repositories','people','lists'].includes(group)
    || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50
    || !Array.isArray(exclusions) || exclusions.length > 500 || !exclusions.every(v => typeof v === 'string' && isValidUuid(v))
    || !filters || typeof filters !== 'object' || Array.isArray(filters)
    || Object.keys(filters).some(k => !['languages','topics'].includes(k))
    || !strings(filters.languages ?? [],64) || !strings(filters.topics ?? [],100,true)
    || (b.cursor != null && (typeof b.cursor !== 'string' || b.cursor.length > 100))) throw new SearchInputError('Invalid search query, filters or pagination.');
  return { schema_version: 2, search_id: b.search_id.toLowerCase(), query, group: group as SearchGroup, limit: Number(limit),
    exclude_repo_ids: [...new Set(exclusions.map(v => v.toLowerCase()))],
    filters: { languages: [...new Set(filters.languages as string[] ?? [])], topics: [...new Set(filters.topics as string[] ?? [])] }, cursor: b.cursor as string ?? null };
}

export function parseSemanticResponse(body: unknown, searchId: string): { repo_id: string; score: number }[] {
  if (!body || typeof body !== 'object') throw new Error('Invalid ML search response.');
  const b = body as Record<string, unknown>;
  if (b.schema_version !== 2 || b.search_id !== searchId || typeof b.embedding_version !== 'string'
    || !b.embedding_version.trim() || b.embedding_version.length > 128 || !Array.isArray(b.items) || b.items.length > 100
    || Object.keys(b).some(k => !['schema_version','search_id','embedding_version','items'].includes(k))) throw new Error('Invalid ML search envelope.');
  const scores = new Map<string, number>();
  for (const raw of b.items) {
    if (!raw || typeof raw !== 'object') continue;
    const { repo_id: id, score } = raw;
    if (typeof id !== 'string' || !isValidUuid(id) || typeof score !== 'number' || !Number.isFinite(score) || score < -1 || score > 1) continue;
    const key = id.toLowerCase();
    scores.set(key, Math.max(scores.get(key) ?? -1, score));
  }
  return [...scores].map(([repo_id, score]) => ({ repo_id, score })).sort((a,b) => b.score-a.score || a.repo_id.localeCompare(b.repo_id));
}

/** RRF k=60, equal semantic/lexical weight; exact name/full_name always first. */
export function hybridRank(lexical: { id: string; exact: boolean }[], semantic: { repo_id: string; score: number }[]): string[] {
  const scores = new Map<string, number>();
  const exact = new Set(lexical.filter(v => v.exact).map(v => v.id));
  for (const ids of [lexical.map(v => v.id), semantic.map(v => v.repo_id)]) {
    [...new Set(ids)].forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (61 + index)));
  }
  return [...scores.keys()].sort((a,b) => Number(exact.has(b))-Number(exact.has(a)) || scores.get(b)!-scores.get(a)! || a.localeCompare(b));
}

export function preserveHydrationOrder(refs: SearchRef[], rows: SearchResult[]): SearchResult[] {
  const byId = new Map(rows.map(row => [`${row.type}:${row.id}`, row]));
  return refs.flatMap(ref => { const row = byId.get(`${ref.type}:${ref.id}`); return row ? [row] : []; });
}

export class SearchService {
  constructor(private readonly persistence: SearchPersistence,
    private readonly semantic: (request: SearchRequest, signal?: AbortSignal) => Promise<unknown>,
    private readonly now = Date.now,
    private readonly snapshots: SearchSnapshotStore = new MemorySearchSnapshotStore()) {}

  async search(viewer: string, request: SearchRequest, signal?: AbortSignal) {
    const work = createSearchWork(signal);
    checkSearchWork(work);
    const binding = JSON.stringify([viewer, request.query, request.group,
      [...request.filters.languages].sort(), [...request.filters.topics].sort(), [...request.exclude_repo_ids].sort()]);
    let key: string; let offset = 0;
    let snapshot;
    if (request.cursor) {
      const parts = request.cursor.split(':'); key = parts[0]; offset = Number(parts[1]);
      snapshot = await this.snapshots.get(key);
      if (parts.length !== 2 || !Number.isInteger(offset) || offset < 0 || !snapshot || snapshot.expires <= this.now() || snapshot.binding !== binding || offset > snapshot.refs.length) throw new SearchExpiredError('Search expired. Search again.');
    } else {
      const build = async (sharedSignal?: AbortSignal): Promise<SearchSnapshot> => {
        // A Redis build belongs to all its waiters, not the leader's HTTP request.
        const retrieval = sharedSignal ? createSearchWork(sharedSignal, work.deadline) : work;
        checkSearchWork(retrieval);
        const repositories = request.group === 'all' || request.group === 'repositories';
        const [lexical, people, lists, semantic] = await settleSearchWork([
          repositories ? this.persistence.lexical(request, retrieval) : [],
          ['all','people'].includes(request.group) ? this.persistence.people(request, retrieval) : [],
          ['all','lists'].includes(request.group) ? this.persistence.lists(viewer, request, retrieval) : [],
          repositories ? this.semantic(request, retrieval.signal).then(body => ({ items: parseSemanticResponse(body, request.search_id), ok: true })).catch(() => ({ items: [], ok: false })) : { items: [], ok: true },
        ] as const);
        checkSearchWork(retrieval);
        const excluded = new Set(request.exclude_repo_ids);
        const repos: SearchRef[] = hybridRank(lexical, semantic.items).filter(id => !excluded.has(id)).map(id => ({ type: 'repository', id }));
        const refs: SearchRef[] = [];
        const seen = new Set<string>();
        // All interleaves groups; per-group order is retained and filters don't guess intent.
        for (let i = 0; i < Math.max(repos.length, people.length, lists.length); i++) {
          for (const group of [repos,people,lists]) {
            const ref = group[i];
            if (!ref) continue;
            const identity = `${ref.type}:${ref.id}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            refs.push(ref);
          }
        }
        return { binding, refs, mode: semantic.ok ? 'hybrid' as const : 'lexical' as const, expires: this.now()+120_000 };
      };
      if (this.snapshots.getOrCreate) {
        ({ key, snapshot } = await this.snapshots.getOrCreate(binding, viewer, build, work.signal));
      } else {
        snapshot = await build();
        key = crypto.randomUUID();
        await this.snapshots.set(key, snapshot);
      }
    }
    checkSearchWork(work);
    const items: SearchResult[] = [];
    let examined = 0;
    // Revalidate every page against PostgreSQL; deleted/private results are skipped and topped up.
    while (items.length < request.limit && offset < snapshot.refs.length && examined < HYDRATION_PAGE_BUDGET) {
      checkSearchWork(work);
      const missing = request.limit - items.length;
      const window = Math.min(HYDRATION_MAX_WINDOW, Math.max(HYDRATION_MIN_WINDOW, missing * 3), HYDRATION_PAGE_BUDGET - examined);
      const refs = snapshot.refs.slice(offset, offset + window);
      examined += refs.length;
      const hydrated = await this.persistence.hydrate(viewer, refs, request, work);
      checkSearchWork(work);
      const accepted = preserveHydrationOrder(refs, hydrated).slice(0, missing);
      items.push(...accepted);
      // Hydrated surplus is not consumed or cached: leave it behind the cursor
      // so the next page rechecks its permissions, active state and filters.
      const last = accepted.at(-1);
      offset += accepted.length === missing
        ? refs.findIndex(ref => ref.type === last!.type && ref.id === last!.id) + 1
        : refs.length;
    }
    checkSearchWork(work);
    return { schema_version: 2, search_id: request.search_id, mode: snapshot.mode, items,
      next_cursor: offset < snapshot.refs.length ? `${key!}:${offset}` : null };
  }
}
