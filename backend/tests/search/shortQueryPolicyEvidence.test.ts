import assert from 'node:assert/strict';
import test from 'node:test';
import { assertShortQueryTarget, describeQuery } from '../../scripts/short-query-policy-evidence.js';
import { parseSearchRequest } from '../../services/searchService.js';

test('short-query evidence refuses shared, remote and production targets before dynamic SQL imports', () => {
  for (const url of [undefined,'postgres://localhost/weave_scroll','postgres://remote.invalid/weave_short_query_policy_test','https://localhost/weave_short_query_policy_test']) {
    assert.throws(()=>assertShortQueryTarget(url,'test'));
  }
  assert.throws(()=>assertShortQueryTarget('postgres://127.0.0.1/weave_short_query_policy_test','production'));
  assert.equal(assertShortQueryTarget('postgres://127.0.0.1/weave_short_query_policy_test','test').hostname,'127.0.0.1');
});
test('current validation and evidence expose UTF16/codepoint/grapheme differences without adopting a policy', () => {
  const request=(query:string)=>parseSearchRequest({schema_version:2,search_id:'11800000-0000-4000-8000-000000000001',query});
  assert.throws(()=>request('g'));
  assert.equal(request('😀').query,'😀');
  assert.deepEqual(describeQuery('😀'),{query:'😀',utf16_units:2,code_points:1,nfc_code_points:1,graphemes:1});
  assert.deepEqual(describeQuery('e\u0301'),{query:'e\u0301',utf16_units:2,code_points:2,nfc_code_points:1,graphemes:1});
  assert.equal(describeQuery('数据').code_points,2);
  assert.equal(request('go').query,'go');
});
