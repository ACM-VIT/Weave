import { sqlClient } from '../db/index.js';
import { getRepositoryDetails } from '../services/repositoryDetailService.js';
import { isValidUuid } from '../utils/validators.js';
import type { SearchPersistence, SearchRef, SearchRequest, SearchResult } from '../services/searchService.js';

export function searchPattern(query: string): string { return `%${query.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`; }
const userText = `lower(coalesce(u.username::text,'')||' '||coalesce(u.full_name,'')||' '||coalesce(u.github_handle,'')||' '||coalesce(u.bio,''))`;
const profileText = `lower(coalesce(p.handle,'')||' '||coalesce(p.display_name,''))`;
const listText = (alias: string) => `lower(${alias}.name||' '||coalesce(${alias}.description,''))`;

// Collections are private owner Lists; Boards are legacy Lists with visibility.
const listRows = (collectionPredicate = '', boardPredicate = '') => `SELECT 'collection:'||c.collection_id::text AS id,c.collection_id AS raw_id,'collection' AS source,
  c.user_id,c.name,c.description,c.icon,c.color,c.created_at,c.updated_at,
  (SELECT count(*)::int FROM app.collection_repos cr JOIN app.repos r USING(repo_id) WHERE cr.collection_id=c.collection_id AND r.status='active') AS repo_count,
  (SELECT count(*)::int FROM app.boards b WHERE b.collection_id=c.collection_id) AS board_count,
  ${listText('c')} AS search_text
  FROM app.board_collections c JOIN app.users owner ON owner.user_id=c.user_id AND owner.status='active'
  WHERE c.user_id=$1::uuid ${collectionPredicate}
  UNION ALL
  SELECT 'legacy-board:'||b.board_id::text,b.board_id,'legacy-board',b.user_id,b.name,b.description,
  NULL::text,NULL::text,b.created_at,NULL::timestamptz,
  (SELECT count(*)::int FROM app.board_repos br JOIN app.repos r USING(repo_id) WHERE br.board_id=b.board_id AND r.status='active'),0,
  ${listText('b')}
  FROM app.boards b JOIN app.users owner ON owner.user_id=b.user_id AND owner.status='active'
  WHERE (b.user_id=$1::uuid OR b.visibility='public') ${boardPredicate}`;

const peopleRows = (userPredicate = '', profilePredicate = '') => `SELECT 'user:'||u.user_id::text AS id,u.user_id,NULL::uuid AS profile_id,
  u.username::text AS username,u.full_name AS display_name,u.github_handle,u.bio,u.avatar_url,
  ${userText} AS search_text,
  COALESCE((SELECT string_agg(p.handle||' '||coalesce(p.display_name,''),' ') FROM app.social_profiles p
    WHERE p.claimed_by_user_id=u.user_id AND p.status='active'),'') AS social_text
  FROM app.users u WHERE u.status='active' ${userPredicate}
  UNION ALL
  SELECT 'profile:'||p.profile_id::text,NULL::uuid,p.profile_id,p.handle,p.display_name,p.handle,NULL::text,p.avatar_url,
  ${profileText},''::text FROM app.social_profiles p
  WHERE p.status='active' ${profilePredicate} AND p.claimed_by_user_id IS NULL AND p.profile_kind IN ('user','unknown')
  AND NOT EXISTS (SELECT 1 FROM app.users u WHERE
    (u.github_id IS NOT NULL AND u.github_id=p.provider_subject)
    OR ((u.github_id IS NULL OR p.provider_subject IS NULL)
      AND u.github_identity_verified_at IS NOT NULL AND lower(u.github_handle)=lower(p.handle)))`;

export class PostgresSearchPersistence implements SearchPersistence {
  async lexical(request: SearchRequest) {
    const rows = await sqlClient`
      SELECT r.repo_id AS id,(lower(r.name)=lower(${request.query}) OR lower(r.full_name)=lower(${request.query})) AS exact
      FROM app.repos r LEFT JOIN app.repo_content c USING(repo_id)
      WHERE r.status='active' AND NOT (r.repo_id=ANY(${request.exclude_repo_ids}::uuid[]))
        AND (lower(r.full_name) LIKE ${searchPattern(request.query)}
          OR lower(coalesce(c.description,'')) LIKE ${searchPattern(request.query)})
        AND (${request.filters.languages.length === 0} OR c.primary_language=ANY(${request.filters.languages}::text[]))
        AND (${request.filters.topics.length === 0} OR EXISTS (
          SELECT 1 FROM app.repo_topics rt JOIN app.topics t USING(topic_id)
          WHERE rt.repo_id=r.repo_id AND t.slug=ANY(${request.filters.topics}::text[])))
      ORDER BY exact DESC,(lower(r.name) LIKE ${searchPattern(request.query).slice(1)}) DESC,app.explore_similarity(lower(r.full_name),lower(${request.query})) DESC,r.repo_id LIMIT 100
    `;
    return rows.map(row => ({ id: String(row.id), exact: row.exact === true }));
  }
  async people(request: SearchRequest): Promise<SearchRef[]> {
    const rows = await sqlClient.unsafe(`WITH candidates AS (${peopleRows()}) SELECT id FROM candidates
      WHERE search_text LIKE $1 OR lower(social_text) LIKE $1
      ORDER BY (lower(username)=lower($2)) DESC,app.explore_similarity(search_text,lower($2)) DESC,id LIMIT 100`, [searchPattern(request.query),request.query]);
    return rows.map(row => ({ type: 'person', id: String(row.id) }));
  }
  async lists(viewer: string, request: SearchRequest): Promise<SearchRef[]> {
    const rows = await sqlClient.unsafe(`WITH candidates AS (${listRows()}) SELECT id FROM candidates
      WHERE search_text LIKE $2 ORDER BY (lower(name)=lower($3)) DESC,app.explore_similarity(search_text,lower($3)) DESC,id LIMIT 100`,[viewer,searchPattern(request.query),request.query]);
    return rows.map(row => ({ type: 'list', id: String(row.id) }));
  }
  async hydrate(viewer: string, refs: SearchRef[], request?: SearchRequest): Promise<SearchResult[]> {
    const ids = { repository: [], user: [], profile: [], collection: [], 'legacy-board': [] } as Record<
      'repository' | 'user' | 'profile' | 'collection' | 'legacy-board', string[]>;
    const validRefs: SearchRef[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      let kind: keyof typeof ids;
      let rawId: string;
      if (ref.type === 'repository') {
        kind = 'repository'; rawId = ref.id;
      } else {
        const separator = ref.id.indexOf(':');
        const prefix = ref.id.slice(0, separator);
        if (ref.type === 'person' && (prefix === 'user' || prefix === 'profile')) kind = prefix;
        else if (ref.type === 'list' && (prefix === 'collection' || prefix === 'legacy-board')) kind = prefix;
        else continue;
        rawId = ref.id.slice(separator + 1);
      }
      if (!isValidUuid(rawId)) continue;
      rawId = rawId.toLowerCase();
      const id = kind === 'repository' ? rawId : `${kind}:${rawId}`;
      const key = `${ref.type}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ids[kind].push(rawId);
      validRefs.push({ type: ref.type, id });
    }
    const repoIds = ids.repository;
    const [repos,people,lists] = await Promise.all([
      getRepositoryDetails(viewer, repoIds, false, request?.filters),
      ids.user.length || ids.profile.length ? sqlClient.unsafe(`WITH candidates AS (${peopleRows(
        'AND u.user_id=ANY($1::uuid[])', 'AND p.profile_id=ANY($2::uuid[])',
      )}) SELECT id,user_id,profile_id,username,display_name,github_handle,bio,avatar_url FROM candidates`, [ids.user, ids.profile]) : [],
      ids.collection.length || ids['legacy-board'].length ? sqlClient.unsafe(`WITH candidates AS (${listRows(
        'AND c.collection_id=ANY($2::uuid[])', 'AND b.board_id=ANY($3::uuid[])',
      )}) SELECT * FROM candidates`, [viewer, ids.collection, ids['legacy-board']]) : [],
    ]);
    const rows: SearchResult[] = [
      ...repos.map(repo => ({ type: 'repository' as const, id: String(repo.repo_id), data: { ...repo } })),
      ...people.map(row => ({ type: 'person' as const, id: String(row.id), data: { ...row } })),
      ...lists.map(row => ({ type: 'list' as const, id: String(row.id), data: {
        id: String(row.raw_id), source: row.source, name: row.name, description: row.description,
        icon: row.icon, color: row.color, repositoryCount: Number(row.repo_count), nestedListCount: Number(row.board_count),
        selected: false, createdAt: row.created_at, updatedAt: row.updated_at, lastUpdatedAt: null,
      } })),
    ];
    const byId = new Map(rows.map(row => [`${row.type}:${row.id}`, row]));
    return validRefs.flatMap(ref => { const row = byId.get(`${ref.type}:${ref.id}`); return row ? [row] : []; });
  }
}
