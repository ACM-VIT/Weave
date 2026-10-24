import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

const integration = process.env.RUN_DATABASE_INTEGRATION === '1' ? test : test.skip;
integration('SQL preserves immutable README bases and rejects unsafe lookalikes', async () => {
  assertDisposableDatabase();
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const id = crypto.randomUUID();
  const commit = '9006287f27e720000cc8763ae4cd150789b8571d';
  const prefix = 'https://raw.githubusercontent.com/owner/pinned-readme/';
  try {
    await sql`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url)
      VALUES (${id}::uuid,9900005601,'owner/pinned-readme','owner','pinned-readme','https://github.com/owner/pinned-readme')`;
    await sql`INSERT INTO app.repo_content(repo_id,content_hash,readme_source_path,readme_default_branch,readme_base_url)
      VALUES (${id}::uuid,'immutable-readme-test','docs/README.md','main',${prefix + commit + '/docs/'})`;
    assert.equal((await sql`SELECT readme_base_url FROM app.repo_content WHERE repo_id=${id}::uuid`)[0].readme_base_url,
      prefix + commit + '/docs/');
    for (const url of [prefix + commit + '/', prefix + 'refs/heads/main/docs/']) {
      await sql`UPDATE app.repo_content SET readme_base_url=${url} WHERE repo_id=${id}::uuid`;
    }
    for (const url of [prefix + commit.slice(1) + '/', prefix + commit + '/docs//',
      prefix + commit + '/?token=secret', prefix.replace('raw.githubusercontent.com', 'raw.githubusercontent.com.evil.example') + commit + '/']) {
      await assert.rejects(sql`UPDATE app.repo_content SET readme_base_url=${url} WHERE repo_id=${id}::uuid`,
        (error: unknown) => (error as {code?: string}).code === '23514');
    }
  } finally {
    await sql`DELETE FROM app.repos WHERE repo_id=${id}::uuid`;
    await sql.end();
  }
});
