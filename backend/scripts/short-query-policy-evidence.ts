/** Disposable evidence only. This module is never imported by search runtime. */
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createSearchWork } from '../services/searchWork.js';

export function assertShortQueryTarget(value: string | undefined, nodeEnv = process.env.NODE_ENV): URL {
  if (!value || nodeEnv === 'production') throw new Error('An explicit disposable database is required.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/weave_short_query_policy_test') throw new Error('Only the owned loopback /weave_short_query_policy_test database is permitted.');
  return url;
}
export function describeQuery(value: string) {
  const query = value.trim();
  return { query, utf16_units: query.length, code_points: Array.from(query).length,
    nfc_code_points: Array.from(query.normalize('NFC')).length,
    graphemes: [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(query)].length };
}

async function run() {
  assertShortQueryTarget(process.env.DATABASE_URL);
  const args = process.argv.slice(2);
  if (args.some(value => !['--seed', '--measure'].includes(value)) || !args.length) throw new Error('Use --seed and/or --measure. No production policy is changed.');
  const [{ sqlClient: sql }, { PostgresSearchPersistence }, { closeSearchSql, searchSql }, { parseSearchRequest }] = await Promise.all([
    import('../db/index.js'), import('../adapters/postgresSearchPersistence.js'), import('../db/searchSqlLane.js'), import('../services/searchService.js'),
  ]);
  // dotenv may have loaded NODE_ENV during the dynamic database import.
  assertShortQueryTarget(process.env.DATABASE_URL);
  const viewer = '11800000-0000-4000-8000-000000000001';
  const peer = '11800000-0000-4000-8000-000000000002';
  try {
    if (args.includes('--seed')) {
      const [existing] = await sql`SELECT (SELECT count(*) FROM app.repos)+(SELECT count(*) FROM app.users)+(SELECT count(*) FROM app.social_profiles) AS count`;
      if (Number(existing.count)) throw new Error('Fixture seeding requires an empty dedicated product schema; existing data is never cleared.');
      await sql.begin(async tx => {
        await tx`INSERT INTO auth.users(id) SELECT md5('118-user-'||i)::uuid FROM generate_series(1,20000) i`;
        await tx`INSERT INTO auth.users(id) VALUES(${viewer}::uuid),(${peer}::uuid)`;
        await tx`INSERT INTO app.users(user_id,username,full_name,bio,status)
          SELECT md5('118-user-'||i)::uuid,'person-'||i,CASE WHEN i%10=0 THEN 'go-person-'||i ELSE 'algo-person-'||i END,
          CASE WHEN i%1000=0 THEN 'zx selective' WHEN i%4=0 THEN 'go compiler' ELSE 'database' END,'active' FROM generate_series(1,20000) i`;
        await tx`INSERT INTO app.users(user_id,username,full_name) VALUES(${viewer}::uuid,'fixture-viewer','Tarun'),(${peer}::uuid,'fixture-peer','Peer')`;
        await tx`INSERT INTO app.social_profiles(profile_id,provider,provider_subject,handle,display_name,profile_kind,status)
          SELECT md5('118-profile-'||i)::uuid,'github',(700000000+i)::text,'external-'||i,
          CASE WHEN i%10=0 THEN 'go-external-'||i ELSE 'algo-external-'||i END,'user','active' FROM generate_series(1,20000) i`;
        await tx`INSERT INTO app.repos(repo_id,github_id,owner,full_name,name,url,status)
          SELECT md5('118-repo-'||i)::uuid,800000000+i,'fixture',
          'fixture/'||CASE WHEN i%1000=0 THEN 'zx-' WHEN i%10=0 THEN 'go-' ELSE 'algo-' END||i,
          CASE WHEN i%1000=0 THEN 'zx-' WHEN i%10=0 THEN 'go-' ELSE 'algo-' END||i,
          'https://github.com/fixture/isolated-'||i,CASE WHEN i%100=1 THEN 'archived' ELSE 'active' END FROM generate_series(1,100000) i`;
        await tx`INSERT INTO app.repo_content(repo_id,description,primary_language,content_hash)
          SELECT repo_id,CASE WHEN github_id%1000=0 THEN 'zx selective toolkit' WHEN github_id%4=0 THEN 'go compiler network utility' ELSE 'data utilities' END,
          CASE WHEN github_id%2=0 THEN 'TypeScript' ELSE 'Python' END,'fixture-only' FROM app.repos`;
        await tx`INSERT INTO app.topics(slug,display_name) VALUES('databases','Databases')`;
        await tx`INSERT INTO app.repo_topics(repo_id,topic_id) SELECT r.repo_id,t.topic_id FROM app.repos r CROSS JOIN app.topics t WHERE r.github_id%5=0`;
        await tx`INSERT INTO app.boards(board_id,user_id,name,description,visibility)
          SELECT md5('118-board-'||i)::uuid,CASE WHEN i%10=0 THEN ${viewer}::uuid ELSE ${peer}::uuid END,
          CASE WHEN i%10=0 THEN 'go-board-' ELSE 'algo-board-' END||i,'go database',
          CASE WHEN i%3=0 THEN 'private' WHEN i%3=1 THEN 'unlisted' ELSE 'public' END FROM generate_series(1,20000) i`;
        await tx`INSERT INTO app.board_collections(collection_id,user_id,name,description)
          SELECT md5('118-list-'||i)::uuid,CASE WHEN i%10=0 THEN ${viewer}::uuid ELSE ${peer}::uuid END,
          CASE WHEN i%10=0 THEN 'go-list-' ELSE 'algo-list-' END||i,'go collection' FROM generate_series(1,2000) i`;
        // Isolated known recall cases, not representative relevance judgments.
        for (const [index, name, description] of [[1, 'go', 'exact short name'], [2, 'go-kit', 'prefix short name'], [3, 'algo', 'internal short substring'],
          [4, 'data-tool', 'go description only'], [5, '数据-tool', 'CJK prefix'], [6, 'database', '数据 description only'],
          [7, 'éé-tool', 'accented prefix'], [8, '😀-tool', 'single astral scalar']] as const) {
          const id = `11800000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`;
          await tx`INSERT INTO app.repos(repo_id,github_id,owner,full_name,name,url) VALUES(${id}::uuid,${String(900000000+index)}::bigint,'sentinel',${'sentinel/'+name},${name},${'https://github.com/sentinel/'+name})`;
          await tx`INSERT INTO app.repo_content(repo_id,description,primary_language,content_hash) VALUES(${id}::uuid,${description},'TypeScript','fixture-only')`;
        }
      });
      await sql.unsafe('ANALYZE app.repos; ANALYZE app.repo_content; ANALYZE app.users; ANALYZE app.social_profiles; ANALYZE app.boards; ANALYZE app.board_collections; ANALYZE app.repo_topics; ANALYZE app.topics').simple();
    }
    if (!args.includes('--measure')) return;
    const [settings] = await sql`SELECT version(),datcollate AS lc_collate,current_setting('shared_buffers') AS shared_buffers FROM pg_database WHERE datname=current_database()`;
    await sql.unsafe('DROP INDEX IF EXISTS app.evidence_118_repo_name_prefix,app.evidence_118_repo_full_name_prefix,app.evidence_118_user_username_prefix,app.evidence_118_user_full_name_prefix,app.evidence_118_profile_handle_prefix,app.evidence_118_profile_display_prefix,app.evidence_118_board_prefix,app.evidence_118_collection_prefix').simple();
    const persistence = new PostgresSearchPersistence();
    const records: unknown[] = [];
    const queries = ['g', 'go', 'zx', 'gol', 'database', '数据', 'éé', '😀', 'e\u0301', '%_'];
    for (const query of queries) for (const group of ['all','repositories','people','lists']) {
      let request: ReturnType<typeof parseSearchRequest>;
      try { request = parseSearchRequest({ schema_version: 2, search_id: crypto.randomUUID(), query, group }); }
      catch { records.push({ policy: 'current', ...describeQuery(query), group, accepted: false }); continue; }
      for (const filtered of group === 'repositories' ? [false, true] : [false]) {
        if (filtered) request = { ...request, filters: { languages: ['TypeScript'], topics: ['databases'] } };
        const samples = [];
        for (let repeat = 0; repeat < 4; repeat++) {
          const start = performance.now();
          const rows = await Promise.all([
            group === 'all' || group === 'repositories' ? persistence.lexical(request) : [],
            group === 'all' || group === 'people' ? persistence.people(request) : [],
            group === 'all' || group === 'lists' ? persistence.lists(viewer, request) : [],
          ]);
          samples.push({ elapsed_ms: performance.now()-start, counts: rows.map(values => values.length),
            rows_sha256: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
            sentinel_ids: rows.flat().filter(row => row.id.includes('11800000')).map(row => row.id) });
        }
        records.push({ policy: 'current', ...describeQuery(query), group, filtered, accepted: true, samples });
      }
    }
    // Alternative is intentionally fixture-only and visibly changes recall.
    // Prefix indexes are created only in this dedicated evidence database.
    await sql.unsafe(`CREATE INDEX IF NOT EXISTS evidence_118_repo_name_prefix ON app.repos(lower(name) text_pattern_ops) WHERE status='active';
      CREATE INDEX IF NOT EXISTS evidence_118_repo_full_name_prefix ON app.repos(lower(full_name) text_pattern_ops) WHERE status='active';
      CREATE INDEX IF NOT EXISTS evidence_118_user_username_prefix ON app.users(lower(username::text) text_pattern_ops) WHERE status='active';
      CREATE INDEX IF NOT EXISTS evidence_118_user_full_name_prefix ON app.users(lower(coalesce(full_name,'')) text_pattern_ops) WHERE status='active';
      CREATE INDEX IF NOT EXISTS evidence_118_profile_handle_prefix ON app.social_profiles(lower(handle) text_pattern_ops) WHERE status='active';
      CREATE INDEX IF NOT EXISTS evidence_118_profile_display_prefix ON app.social_profiles(lower(coalesce(display_name,'')) text_pattern_ops) WHERE status='active';
      CREATE INDEX IF NOT EXISTS evidence_118_board_prefix ON app.boards(lower(name) text_pattern_ops);
      CREATE INDEX IF NOT EXISTS evidence_118_collection_prefix ON app.board_collections(lower(name) text_pattern_ops);`).simple();
    for (const query of ['go','zx','数据','éé','😀']) {
      const escaped = query.toLowerCase().replace(/[\\%_]/g,'\\$&');
      for (const filtered of [false, true]) {
        const samples = [];
        for (let repeat=0;repeat<4;repeat++) {
          const start = performance.now();
          const rows = await searchSql(createSearchWork(), async db => db`SELECT r.repo_id AS id FROM app.repos r LEFT JOIN app.repo_content c USING(repo_id)
            WHERE r.status='active' AND (lower(r.name) LIKE ${escaped+'%'} OR lower(r.full_name) LIKE ${escaped+'%'})
            AND (${!filtered} OR (c.primary_language='TypeScript' AND EXISTS(SELECT 1 FROM app.repo_topics rt JOIN app.topics t USING(topic_id) WHERE rt.repo_id=r.repo_id AND t.slug='databases')))
            ORDER BY (lower(r.name)=${query.toLowerCase()}) DESC,r.repo_id LIMIT 100`);
          samples.push({elapsed_ms:performance.now()-start,count:rows.length,rows_sha256:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),sentinel_ids:rows.filter(row=>String(row.id).startsWith('11800000')).map(row=>row.id)});
        }
        records.push({policy:'prototype_name_prefix',...describeQuery(query),group:'repositories',filtered,samples});
      }
    }
    for (const query of ['go','zx','数据','éé']) for (const group of ['people','lists']) {
      const prefix = query.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%';
      const samples = [];
      for (let repeat=0;repeat<4;repeat++) {
        const start = performance.now();
        const rows = await searchSql(createSearchWork(), async db => group === 'people' ? db`
          WITH matching_users AS (
            SELECT u.user_id FROM app.users u WHERE u.status='active' AND (lower(u.username::text) LIKE ${prefix}
              OR lower(coalesce(u.full_name,'')) LIKE ${prefix} OR lower(coalesce(u.github_handle,'')) LIKE ${prefix})
            UNION SELECT p.claimed_by_user_id FROM app.social_profiles p WHERE p.status='active' AND p.claimed_by_user_id IS NOT NULL
              AND (lower(p.handle) LIKE ${prefix} OR lower(coalesce(p.display_name,'')) LIKE ${prefix})
          ), candidates AS (
            SELECT 'user:'||u.user_id::text AS id,u.username::text AS name FROM app.users u
              WHERE u.status='active' AND u.user_id IN (SELECT user_id FROM matching_users)
            UNION ALL SELECT 'profile:'||p.profile_id::text,p.handle FROM app.social_profiles p
              WHERE p.status='active' AND p.claimed_by_user_id IS NULL AND p.profile_kind IN ('user','unknown')
              AND (lower(p.handle) LIKE ${prefix} OR lower(coalesce(p.display_name,'')) LIKE ${prefix})
              AND NOT EXISTS(SELECT 1 FROM app.users u WHERE (u.github_id IS NOT NULL AND u.github_id=p.provider_subject)
                OR ((u.github_id IS NULL OR p.provider_subject IS NULL) AND u.github_identity_verified_at IS NOT NULL AND lower(u.github_handle)=lower(p.handle)))
          ) SELECT id FROM candidates ORDER BY (lower(name)=${query.toLowerCase()}) DESC,id LIMIT 100`
          : db`WITH candidates AS (
            SELECT 'collection:'||c.collection_id::text AS id,c.name FROM app.board_collections c
              JOIN app.users u ON u.user_id=c.user_id AND u.status='active' WHERE c.user_id=${viewer}::uuid AND lower(c.name) LIKE ${prefix}
            UNION ALL SELECT 'legacy-board:'||b.board_id::text,b.name FROM app.boards b
              JOIN app.users u ON u.user_id=b.user_id AND u.status='active' WHERE (b.user_id=${viewer}::uuid OR b.visibility='public') AND lower(b.name) LIKE ${prefix}
          ) SELECT id FROM candidates ORDER BY (lower(name)=${query.toLowerCase()}) DESC,id LIMIT 100`);
        samples.push({elapsed_ms:performance.now()-start,count:rows.length,rows_sha256:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')});
      }
      records.push({policy:'prototype_name_prefix',...describeQuery(query),group,filtered:false,samples});
    }
    const source = await readFile(new URL('../adapters/postgresSearchPersistence.ts',import.meta.url));
    console.log(JSON.stringify({ fixture: 'synthetic-local-v1', production_latency_claim: false, selected_policy: 'keep_broad_names_descriptions_bios', prototype_policy_approved: false,
      baseline_path: 'actual PostgresSearchPersistence + searchSql lane', source_sha256: crypto.createHash('sha256').update(source).digest('hex'),
      measurement: 'first call plus 3 warm repeats; loopback and concurrent per-group SQL; not HTTP/ML/end-to-end latency',
      settings, records }, null, 2));
  } finally { await closeSearchSql(); await sql.end({ timeout: 1 }); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch(error => { console.error(error instanceof Error ? error.message : 'Evidence failed.'); process.exitCode=1; });
}
