import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReadmeDigest, readmeSummaryQueryKey, readmeDigestMarkdown, resolveReadmeDigest, type ReadmeDigest } from '../src/models/readme-digest';
import { prepareReadmePreview, prepareReadmeSummaryDocument } from '../src/utils/readme';
import { mapRepositoryDetail } from '../src/utils/repository-mapper';

const digest:ReadmeDigest={
  summary_id:'00000000-0000-4000-8000-000000000001',content_version:4,content_hash:'source-v4',
  prompt_version:'readme-digest-v1',format_version:'readme-digest-json-v1',model_version:'real-provider-model',
  source:'generated',generated_at:'2026-10-21T06:00:00.000Z',
  overview:'A structured explanation of the repository purpose and how its main parts work together. '.repeat(4).trim(),
  capabilities:['Reusable task execution adapters support different processing implementations.','Shared progress events keep application state and interfaces consistent.'],
  use_cases:['Developers can coordinate visible document processing and import workflows.'],
  considerations:['Background task execution requires an available worker process.'],
};

test('V2 digest decoding rejects incomplete, wrong-version and malformed provider artifacts',()=>{
  assert.deepEqual(parseReadmeDigest(digest),digest);
  for(const value of [null,{...digest,source:'description_fallback'},{...digest,format_version:'old-format'},
    {...digest,capabilities:'JSON string, not an array'},{...digest,content_version:0},{...digest,generated_at:'not-a-date'}]){
    assert.equal(parseReadmeDigest(value),null);
  }
});

test('structured README preview is independent of the subtitle and keeps more than 360 characters for measured line clipping',()=>{
  const preview=prepareReadmePreview({digest,description:'The one-line subtitle.',fullReadme:'# The full README',maximumCharacters:20});
  assert.equal(preview.source,'summary');
  assert.ok(preview.markdown.length>360);
  assert.ok(preview.markdown.startsWith(digest.overview));
  assert.ok(!preview.markdown.includes('one-line subtitle'));
  assert.ok(!preview.markdown.includes('The full README'));
});

test('Read more presents the complete structured digest including caveats, without raw README substitution',()=>{
  const markdown=prepareReadmeSummaryDocument({readmeDigest:digest,readmeSummary:null,description:'Subtitle',readmeFull:'# Raw source\n'.repeat(100)});
  assert.equal(markdown,readmeDigestMarkdown(digest));
  for(const section of ['Key capabilities','Use cases','Things to know'])assert.ok(markdown?.includes(section));
  assert.ok(markdown?.includes(digest.considerations[0]));
  assert.ok(!markdown?.includes('Raw source'));
});

test('canonical mapping keeps a V2 digest, short summary, subtitle and raw README as distinct values',()=>{
  const mapped=mapRepositoryDetail({repo_id:'repo-1',full_name:'team/project',description:'Short subtitle.',
    summary:'A concise discovery card summary.',readme_digest:digest,readme_md:'# Full documentation'});
  assert.ok(mapped);
  assert.equal(mapped.readmeDigest?.overview,digest.overview);
  assert.equal(mapped.readmeSummary,'A concise discovery card summary.');
  assert.equal(mapped.description,'Short subtitle.');
  assert.equal(mapped.readmeFull,'# Full documentation');
});

test('async digest refresh preserves useful cached content and excludes a newer README version without an artifact',()=>{
  assert.equal(resolveReadmeDigest(digest,undefined),digest);
  assert.equal(resolveReadmeDigest(digest,{content_version:3,summary:null}),digest);
  assert.equal(resolveReadmeDigest(digest,{content_version:4,summary:null}),digest);
  assert.equal(resolveReadmeDigest(digest,{content_version:5,summary:null}),null);
  const refreshed={...digest,summary_id:'new-regeneration'};
  assert.equal(resolveReadmeDigest(digest,{content_version:4,summary:refreshed}),refreshed);
  const popup=prepareReadmeSummaryDocument({readmeSummary:null,readmeFull:'# Raw source',description:'Subtitle',readmeDigest:refreshed});
  assert.ok(popup?.includes(refreshed.overview));
});

test('a newer canonical README excludes cached old digests even before its fetch returns',()=>{
  assert.equal(resolveReadmeDigest(null,{content_version:4,summary:digest},5),null);
  assert.equal(resolveReadmeDigest(digest,undefined,5),null);
  assert.equal(resolveReadmeDigest(digest,{content_version:3,summary:null},4),digest);
  const newer={...digest,content_version:5,content_hash:'hash-v5'};
  assert.equal(resolveReadmeDigest(null,{content_version:5,summary:newer},5),newer);
});

test('digest query caches separate canonical content versions and accounts',()=>{
  assert.notDeepEqual(readmeSummaryQueryKey('viewer','repo',4),readmeSummaryQueryKey('viewer','repo',5));
  assert.notDeepEqual(readmeSummaryQueryKey('viewer','repo',4),readmeSummaryQueryKey('other','repo',4));
});
