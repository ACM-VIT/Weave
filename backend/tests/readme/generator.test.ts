import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OpenRouterReadmeSummaryGenerator, createReadmeSummaryGenerator, prepareReadmeSummarySource, ReadmeSummaryError, README_SUMMARY_SYSTEM_PROMPT, ReadmeRequestLimiter,
  validateReadmeSummary,
} from '../../services/readmeSummaryGenerator.js';

import { digestFixture } from '../fixtures/readmeDigest.js';

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

async function withProviderEnvironment(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { await run(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('Gemini uses only its selected server key and the same V2 digest contract', async () => {
  await withProviderEnvironment({ README_SUMMARY_PROVIDER:'gemini', README_SUMMARY_API_KEY:undefined, README_SUMMARY_RPM_LIMIT:'0',
    GEMINI_API_KEY:'gemini-test-key', OPENROUTER_API_KEY:'wrong-service-key', README_SUMMARY_MODEL_ID:'gemini-2.5-flash' }, async () => {
    let calls=0;
    const fetcher:typeof fetch=async(url,options)=>{
      calls++;
      assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
      assert.equal(new Headers(options?.headers).get('x-goog-api-key'),'gemini-test-key');
      assert.equal(new Headers(options?.headers).get('authorization'),null);
      const request=JSON.parse(String(options?.body));
      assert.equal(request.generationConfig.responseMimeType,'application/json');
      assert.deepEqual(request.generationConfig.responseJsonSchema.required,['overview','capabilities','use_cases','considerations']);
      assert.equal(request.systemInstruction.parts[0].text,README_SUMMARY_SYSTEM_PROMPT);
      assert.ok(README_SUMMARY_SYSTEM_PROMPT.includes('expert technical writer'));
      assert.ok(!JSON.stringify(request).includes('gemini-test-key'));
      return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[
        {thought:true,text:'Internal reasoning must not enter the artifact.'},{text:JSON.stringify(digestFixture)},
      ]}}]}));
    };
    const generator=createReadmeSummaryGenerator(fetcher);
    assert.equal(generator.modelVersion,'gemini:gemini-2.5-flash');
    assert.deepEqual(await generator.generate(source),digestFixture);
    assert.equal(calls,1);
    const truncated:typeof fetch=async()=>new Response(JSON.stringify({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:JSON.stringify(digestFixture)}]}}]}));
    await assert.rejects(createReadmeSummaryGenerator(truncated).generate(source),/summary_provider_incomplete/);
  });
});

test('future compatible provider uses explicit endpoint, model and key without OpenRouter-specific routing', async () => {
  await withProviderEnvironment({README_SUMMARY_PROVIDER:'openai-compatible',README_SUMMARY_API_KEY:'future-provider-key',
    README_SUMMARY_MODEL_ID:'approved-future-model',README_SUMMARY_BASE_URL:'https://provider.example/v1/'},async()=>{
    const fetcher:typeof fetch=async(url,options)=>{
      assert.equal(url,'https://provider.example/v1/chat/completions');
      assert.equal(new Headers(options?.headers).get('authorization'),'Bearer future-provider-key');
      const request=JSON.parse(String(options?.body));
      assert.equal(request.model,'approved-future-model');
      assert.equal(request.provider,undefined);
      assert.equal(request.response_format.json_schema.strict,true);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(digestFixture)}}]}));
    };
    assert.deepEqual(await createReadmeSummaryGenerator(fetcher).generate(source),digestFixture);
  });
});

test('OpenAI Luna digest requests use supported completion budget and sampling mode', async () => {
  await withProviderEnvironment({README_SUMMARY_PROVIDER:'openai-compatible',README_SUMMARY_API_KEY:'openai-test-key',
    README_SUMMARY_MODEL_ID:'gpt-6-luna',README_SUMMARY_BASE_URL:'https://api.openai.com/v1',README_SUMMARY_RPM_LIMIT:'0'},async()=>{
    let request:Record<string,any>={};
    const fetcher:typeof fetch=async(url,options)=>{
      assert.equal(url,'https://api.openai.com/v1/chat/completions');
      request=JSON.parse(String(options?.body));
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(digestFixture)}}]}));
    };
    const generator=createReadmeSummaryGenerator(fetcher);
    assert.equal(generator.modelVersion,'openai-compatible:gpt-6-luna');
    assert.deepEqual(await generator.generate(source),digestFixture);
    assert.equal(request.max_tokens,undefined);
    assert.equal(request.max_completion_tokens,1400);
    assert.equal(request.reasoning_effort,'none');
    assert.equal(request.provider,undefined);
    assert.equal(request.response_format.json_schema.strict,true);
  });
});

test('provider configuration fails closed instead of silently sending a key to another service',async()=>{
  await withProviderEnvironment({README_SUMMARY_PROVIDER:'unknown'},async()=>{
    assert.throws(()=>createReadmeSummaryGenerator(),/readme_summary_provider_invalid/);
  });
  await withProviderEnvironment({README_SUMMARY_PROVIDER:'gemini',README_SUMMARY_API_KEY:undefined,GEMINI_API_KEY:undefined,GOOGLE_API_KEY:undefined,
    OPENROUTER_API_KEY:'available-but-wrong-provider'},async()=>{
    assert.throws(()=>createReadmeSummaryGenerator(),/readme_summary_api_key_missing/);
  });
  for (const baseUrl of ['http://provider.example/v1','https://username:password@provider.example/v1','https://provider.example/v1?key=secret']) {
    await withProviderEnvironment({README_SUMMARY_PROVIDER:'openai-compatible',README_SUMMARY_API_KEY:'test-key',README_SUMMARY_MODEL_ID:'model',README_SUMMARY_BASE_URL:baseUrl},async()=>{
      assert.throws(()=>createReadmeSummaryGenerator(),/readme_summary_base_url_invalid/);
    });
  }
});

test('request pacing includes consecutive repair attempts without real waits',async()=>{
  let now=1000;
  const delays:number[]=[];
  const limiter=new ReadmeRequestLimiter(15,()=>now,async(milliseconds)=>{delays.push(milliseconds);now+=milliseconds;});
  await limiter.wait();
  await limiter.wait();
  now+=1500;
  await limiter.wait();
  assert.deepEqual(delays,[4000,2500]);
  now+=10000;
  await limiter.wait();
  assert.equal(delays.length,2,'No wait is needed after the request interval has elapsed');
});

test('Gemini distinguishes exhausted daily quota from a retryable minute limit',async()=>{
  await withProviderEnvironment({README_SUMMARY_PROVIDER:'gemini',README_SUMMARY_API_KEY:'test-key',README_SUMMARY_RPM_LIMIT:'0',README_SUMMARY_MODEL_ID:'gemini-2.5-flash'},async()=>{
    for (const [quotaId,code,retryable] of [
      ['GenerateRequestsPerDayPerProjectPerModel-FreeTier','summary_provider_daily_quota_exhausted',false],
      ['GenerateRequestsPerMinutePerProjectPerModel-FreeTier','summary_provider_http_429',true],
    ] as const) {
      let calls=0;
      const fetcher:typeof fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:'Quota exceeded',details:[
        {violations:[{quotaId}]},{retryDelay:'42s'},
      ]}}),{status:429});};
      await assert.rejects(createReadmeSummaryGenerator(fetcher).generate(source),(error:unknown)=>error instanceof ReadmeSummaryError
        && error.code===code && error.retryable===retryable && (!retryable || error.retryAfterSeconds===42));
      assert.equal(calls,1);
    }
  });
});
