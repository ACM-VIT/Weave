import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson,decimalInt64,type CanonicalValue } from '../../contracts/modelOperations.js';
test('canonical operation bytes use Unicode code-point key ordering, original strings and exact decimal int64',()=>{
 assert.equal(canonicalJson({'\u{10000}':1,'\uE000':2}),'{"\uE000":2,"\u{10000}":1}');
 assert.equal(canonicalJson({raw:'{ "Tarun": "Ω" }'}),'{"raw":"{ \\"Tarun\\": \\"Ω\\" }"}');
 assert.equal(decimalInt64('9223372036854775807',true),'9223372036854775807');
 for(const value of ['9223372036854775808','01','-1','1'.repeat(100),''])assert.throws(()=>decimalInt64(value));
 assert.throws(()=>canonicalJson(new Array<CanonicalValue>(1)));
 assert.throws(()=>canonicalJson('\ud800'));
});
