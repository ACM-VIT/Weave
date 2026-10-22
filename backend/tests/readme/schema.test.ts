import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { repoReadmeSummaries, readmeSummaryJobs } from '../../db/v2Schema.js';

const tables = [repoReadmeSummaries, readmeSummaryJobs];
const dialect = new PgDialect();

test('Drizzle describes README artifacts, generation fences, claims, checks and partial indexes', () => {
  const artifact=getTableConfig(repoReadmeSummaries);
  const jobs=getTableConfig(readmeSummaryJobs);
  assert.equal(artifact.schema,'app');
  assert.equal(jobs.schema,'telemetry');
  assert.equal(repoReadmeSummaries.generationId.isUnique,true);
  assert.equal(repoReadmeSummaries.generationId.uniqueName,'repo_readme_summaries_generation_id_key');
  const version=jobs.uniqueConstraints.find(key=>key.name==='readme_summary_jobs_repo_id_content_version_content_hash_pr_key');
  assert.deepEqual(version?.columns.map(column=>column.name),['repo_id','content_version','content_hash','prompt_version']);
  const active=artifact.indexes.find(index=>index.config.name==='repo_readme_summaries_active_uidx');
  assert.equal(active?.config.unique,true);assert.ok(active?.config.where);
  const pending=jobs.indexes.find(index=>index.config.name==='readme_summary_jobs_pending_idx');
  assert.deepEqual(pending?.config.columns.map(column=>'name' in column?column.name:null),['available_at','created_at']);
  assert.match(dialect.sqlToQuery(pending!.config.where!).sql,/'pending','claimed'/);
  assert.equal(artifact.checks.length,6);assert.equal(jobs.checks.length,3);
  assert.match(dialect.sqlToQuery(artifact.checks.find(check=>check.name==='repo_readme_summaries_artifact_check')!.value).sql,/octet_length.*12000/);
  for(const config of [artifact,jobs]){
    assert.equal(config.foreignKeys[0].onDelete,'cascade');
    assert.deepEqual(config.foreignKeys[0].reference().columns.map(column=>column.name),['repo_id']);
  }
});

test('README Drizzle columns and named constraints match migrated PostgreSQL', {
  skip:process.env.RUN_README_SUMMARY_INTEGRATION!=='1',
},async()=>{
  const url=new URL(process.env.README_SUMMARY_TEST_DATABASE_URL??'');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  const client=postgres(url.toString(),{max:1,prepare:false});
  try{
    for(const table of tables){
      const config=getTableConfig(table);
      const columns=await client`SELECT column_name,is_nullable FROM information_schema.columns
        WHERE table_schema=${config.schema!} AND table_name=${config.name} ORDER BY ordinal_position`;
      assert.deepEqual(columns.map(column=>({name:column.column_name,notNull:column.is_nullable==='NO'})),
        config.columns.map(column=>({name:column.name,notNull:column.notNull})));
      const constraints=await client`SELECT conname FROM pg_constraint WHERE conrelid=${`${config.schema}.${config.name}`}::regclass`;
      const expected=[`${config.name}_pkey`,...config.checks.map(check=>check.name),
        ...config.foreignKeys.map(key=>key.getName()),...config.uniqueConstraints.map(key=>key.name),
        ...config.columns.filter(column=>column.isUnique).map(column=>column.uniqueName)].sort();
      assert.deepEqual(constraints.map(row=>String(row.conname)).sort(),expected);
      const indexes=await client`SELECT indexname FROM pg_indexes WHERE schemaname=${config.schema!} AND tablename=${config.name}`;
      for(const index of config.indexes) assert.ok(indexes.some(row=>row.indexname===index.config.name));
    }
  }finally{await client.end({timeout:1});}
});
