import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';

const integration = process.env.RUN_SUMMARY_READ_COMPAT_INTEGRATION === '1' ? test : test.skip;

integration('repository summary reads support older schemas and never promote legacy README summaries', async () => {
  const connection = new URL(process.env.SUMMARY_READ_COMPAT_DATABASE_URL ?? '');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname), 'Use an isolated loopback test database');
  const db = postgres(connection.toString(), { max: 1, prepare: false });
  try {
    const queries: string[] = [];
    const readmeProjections = new Set<string>();
    for (const file of [
      '../../controllers/productV2Controller.ts',
      '../../services/repositoryDetailService.ts',
      '../../adapters/postgresFeedPersistence.ts',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const match of source.matchAll(/to_jsonb\((?:c|content)\)->>'(readme_\w+)' AS \1/g)) {
        readmeProjections.add(match[0].replace(/to_jsonb\((?:c|content)\)/, 'to_jsonb(content)'));
      }
      const laterals = source.matchAll(/LEFT JOIN LATERAL \(\s*(SELECT (?:(?!LEFT JOIN)[\s\S])*?FROM app\.repo_card_summaries (?:(?!LEFT JOIN)[\s\S])*?LIMIT 1)\s*\) \w+ ON/g);
      for (const match of laterals) queries.push(match[1].replace('app.repo_card_summaries', 'pg_temp.compat_summaries'));
    }
    assert.equal(queries.length, 9, 'Exercise every summary subquery used by Lists, detail, and feed reads');
    assert.equal(readmeProjections.size, 3);
    await db`CREATE TEMP TABLE compat_content (readme text)`;
    await db`INSERT INTO pg_temp.compat_content VALUES ('# Complete README')`;
    const readContent = () => db.unsafe(`SELECT content.readme,${[...readmeProjections].join(',')}
      FROM pg_temp.compat_content content`);
    const legacyContent = (await readContent())[0];
    assert.equal(legacyContent.readme, '# Complete README');
    assert.equal(legacyContent.readme_source_path, null);
    assert.equal(legacyContent.readme_base_url, null);
    await db`ALTER TABLE pg_temp.compat_content ADD readme_source_path text,
      ADD readme_default_branch text,ADD readme_base_url text`;
    await db`UPDATE pg_temp.compat_content SET readme_source_path='docs/README.md',
      readme_default_branch='main',readme_base_url='https://raw.githubusercontent.com/owner/repo/main/docs/'`;
    const currentContent = (await readContent())[0];
    assert.equal(currentContent.readme_source_path, 'docs/README.md');
    assert.equal(currentContent.readme_default_branch, 'main');
    assert.equal(currentContent.readme_base_url, 'https://raw.githubusercontent.com/owner/repo/main/docs/');
    await db`CREATE TEMP TABLE compat_summaries (
      summary_id integer,repo_id integer,summary text,content_version integer,
      model_version text,active boolean,created_at timestamptz
    )`;
    await db`INSERT INTO pg_temp.compat_summaries VALUES (1,1,'# Old README',1,'old',true,now())`;
    const read = async (query: string) => db.unsafe(`
      SELECT artifact.* FROM (VALUES (1)) r(repo_id)
      CROSS JOIN (VALUES (1)) repo(repo_id)
      CROSS JOIN (VALUES (1)) c(content_version)
      CROSS JOIN (VALUES (1)) content(content_version)
      CROSS JOIN LATERAL (${query}) artifact
    `);
    for (const query of queries) assert.equal((await read(query)).length, 0, 'Unversioned legacy text must stay out of Summary');
    await db`ALTER TABLE pg_temp.compat_summaries
      ADD highlights jsonb,ADD prompt_version text,ADD format_version text,ADD source text`;
    await db`UPDATE pg_temp.compat_summaries SET source='legacy'`;
    for (const query of queries) assert.equal((await read(query)).length, 0);
    for (const source of ['generated', 'description_fallback']) {
      await db`UPDATE pg_temp.compat_summaries SET source=${source},summary='Concise description.',
        highlights='["Real artifact"]',prompt_version='prompt-v1',format_version='json-v1'`;
      for (const query of queries) {
        const rows = await read(query);
        assert.equal(rows.length, 1);
        if ('summary' in rows[0]) {
          assert.equal(rows[0].summary, 'Concise description.');
          assert.deepEqual(rows[0].highlights, ['Real artifact']);
          assert.equal(rows[0].source, source);
        }
      }
    }
    await db`UPDATE pg_temp.compat_summaries SET content_version=2`;
    for (const query of queries) assert.equal((await read(query)).length, 0, 'Stale content must not be served');
    await db`UPDATE pg_temp.compat_summaries SET content_version=1,active=false`;
    for (const query of queries) assert.equal((await read(query)).length, 0, 'Inactive artifacts must not be served');
  } finally {
    await db.end({ timeout: 1 });
  }
});
