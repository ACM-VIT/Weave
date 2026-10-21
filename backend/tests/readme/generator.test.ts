import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OpenRouterReadmeSummaryGenerator, prepareReadmeSummarySource, ReadmeSummaryError,
  validateReadmeSummary,
} from '../../services/readmeSummaryGenerator.js';
import type { ReadmeSummaryContent } from '../../contracts/readmeSummary.v2.js';

export const digestFixture: ReadmeSummaryContent = {
  overview: 'This project gives application developers reusable building blocks for coordinating background tasks and presenting reliable progress updates. Its modular design separates scheduling, execution, and interface state so teams can adapt the workflow to existing services without maintaining several competing sources of task status.',
  capabilities: [
    'A shared task model keeps state transitions explicit and gives both the interface and background processes a consistent view of ongoing work.',
    'Composable execution adapters let developers connect different job implementations while keeping retry handling and completion reporting in one predictable place.',
    'Progress events support responsive interfaces that can show useful status while asynchronous operations are running across different parts of the application.',
  ],
  use_cases: ['Teams can coordinate document processing, data imports, or application maintenance tasks that need visible progress and dependable recovery after a temporary failure.'],
  considerations: [],
};
const source = { full_name: 'team/project', description: 'Reusable task coordination.', readme: '# Project\n\n' + 'Supported project capabilities and design. '.repeat(40) };

test('structured digest enforces useful length, section bounds, and a closed schema', () => {
  assert.deepEqual(validateReadmeSummary(digestFixture,source),digestFixture);
  for (const invalid of [
    {...digestFixture, overview:'Short subtitle.'}, {...digestFixture, unexpected:'field'},
    {...digestFixture, capabilities:[digestFixture.capabilities[0],digestFixture.capabilities[0]]},
    {...digestFixture, overview:'<script>invalid</script>'.repeat(10)},
    {...digestFixture, considerations:['word '.repeat(100)]},
    {...digestFixture, overview:'One sentence with no useful context.'.repeat(25)},
  ]) assert.throws(() => validateReadmeSummary(invalid),ReadmeSummaryError);
});

test('source preparation removes executable noise and bounds huge README input', () => {
  const prepared = prepareReadmeSummarySource({...source,readme:'# Overview\n\nReadable context.\n\n<script>secretScript()</script>\n\n```sh\ncurl attacker\n```\n\n'+('Meaningful section with grounded information.\n\n'.repeat(50000))});
  assert.ok(prepared.length<=24000);
  assert.ok(!prepared.includes('secretScript'));
  assert.ok(!prepared.includes('curl attacker'));
});

test('provider uses server credentials, strict output, and bounded validation repair', async () => {
  const original=process.env.README_SUMMARY_API_KEY; process.env.README_SUMMARY_API_KEY='private-test-key';
  try {
    let calls=0;
    const fetcher: typeof fetch = async (url,options) => {
      calls++; assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
      const request=JSON.parse(String(options?.body));
      assert.equal(request.response_format.type,'json_schema');
      assert.equal(request.provider.zdr,true);
      assert.equal(request.provider.require_parameters,true);
      assert.equal(request.response_format.json_schema.strict,true);
      assert.ok(!JSON.stringify(request).includes('private-test-key'));
      return new Response(JSON.stringify({choices:[{message:{content:calls===1?'bad-json':JSON.stringify(digestFixture)}}]}));
    };
    assert.deepEqual(await new OpenRouterReadmeSummaryGenerator(fetcher).generate(source),digestFixture);
    assert.equal(calls,2);
    const denied: typeof fetch=async()=>new Response('provider private response',{status:401});
    await assert.rejects(new OpenRouterReadmeSummaryGenerator(denied).generate(source),(error:unknown)=>error instanceof ReadmeSummaryError && error.code==='summary_provider_http_401' && !error.retryable && !error.message.includes('private'));
  } finally { if(original===undefined)delete process.env.README_SUMMARY_API_KEY;else process.env.README_SUMMARY_API_KEY=original; }
});

test('privacy guardrail rejection is explicit, permanent and never retried with weaker settings', async()=>{
  const original=process.env.README_SUMMARY_API_KEY;process.env.README_SUMMARY_API_KEY='private-test-key';
  try {
    let calls=0;
    const denied:typeof fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:'ZDR violation (guardrail)'}}),{status:404});};
    await assert.rejects(new OpenRouterReadmeSummaryGenerator(denied).generate(source),(error:unknown)=>error instanceof ReadmeSummaryError && error.code==='summary_provider_policy_blocked' && !error.retryable);
    assert.equal(calls,1);
  }finally{if(original===undefined)delete process.env.README_SUMMARY_API_KEY;else process.env.README_SUMMARY_API_KEY=original;}
});
