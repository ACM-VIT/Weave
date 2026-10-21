import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import test from 'node:test';

import type { MlRepositoryIndexJob, MlRepositoryIndexResponse } from '../../contracts/ml.v2.js';
import { ML_DESCRIPTION_FALLBACK_MODEL_VERSION } from '../../contracts/ml.v2.js';
import {
  MlV2Client,
  parseMlRepositoryIndexResponse,
} from '../../services/mlService.js';

async function withServer(handler: RequestListener, run: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

const feedback = { schema_version: 2 as const, events: [{
  event_id: '00000000-0000-4000-8000-000000000001', user_id: '00000000-0000-4000-8000-000000000002',
  repo_id: '00000000-0000-4000-8000-000000000003', feedback_version: '1', event_type: 'like' as const,
  dwell_ms: null, occurred_at: new Date(0).toISOString(),
}] };

const repositoryJob: MlRepositoryIndexJob = {
  job_id: '00000000-0000-4000-8000-000000000010',
  repo_id: '00000000-0000-4000-8000-000000000011',
  content_version: 1,
  repository: {
    github_id: '123', full_name: 'owner/repository', url: 'https://github.com/owner/repository',
    description: 'A focused developer discovery application.', primary_language: 'Unknown',
    languages: [], topics: [], readme: '# Repository\n\nCanonical Markdown stays separate.',
    readme_source_path: 'README.md', readme_default_branch: 'main',
    readme_base_url: 'https://raw.githubusercontent.com/owner/repository/refs/heads/main/',
    star_count: 0, fork_count: 0, open_issues_count: 0, pushed_at: null, content_hash: 'hash',
  },
};

function repositoryResponse(overrides: Record<string, unknown> = {}): MlRepositoryIndexResponse {
  return {
    schema_version: 2,
    accepted: true,
    status: 'applied',
    job_id: repositoryJob.job_id,
    repo_id: repositoryJob.repo_id,
    content_version: repositoryJob.content_version,
    embedding_version: 'embedding-v2',
    card_summary: {
      summary: 'Weave helps developers discover useful repositories through concise, personalized project context. It separates quick evaluation from the complete README so technical details remain available on demand.',
      highlights: ['Personalized discovery'],
      prompt_version: 'repo-card-summary-v1',
      model_version: 'test-model',
      format_version: 'repo-card-summary-json-v1',
      source: 'generated',
    },
    ...overrides,
  } as MlRepositoryIndexResponse;
}

test('ML transport classifies 429 and 5xx as retryable and 4xx as terminal', async () => {
  for (const [status, retryable] of [[429, true], [503, true], [400, false]] as const) {
    await withServer((_req, response) => { response.writeHead(status, {
      'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '2' } : {}),
    }); response.end('{}'); }, async (url) => {
      const result = await new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000 })
        .deliverFeedback(feedback);
      assert.equal(result.accepted, false);
      assert.equal(result.retryable, retryable);
      if (status === 429) assert.equal(result.retry_after_ms, 2_000);
    });
  }
});

test('ML delivery accepts plain-text 2xx and preserves terminal plain-text 4xx status', async () => {
  for (const [status, accepted, retryable] of [[202, true, false], [400, false, false]] as const) {
    await withServer((_req, response) => {
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end(status === 202 ? 'accepted' : 'invalid onboarding profile');
    }, async (url) => {
      const result = await new MlV2Client({
        baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000,
      }).deliverFeedback(feedback);
      assert.equal(result.accepted, accepted);
      assert.equal(result.retryable, retryable);
      assert.equal(result.status_code, status);
      assert.equal(result.detail, status === 202 ? 'accepted' : 'invalid onboarding profile');
    });
  }
});

test('repository-index transport adds the v2 envelope without changing strict source keys', async () => {
  let received: Record<string, unknown> | null = null;
  await withServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify(repositoryResponse({ status: 'applied' })));
    });
  }, async (url) => {
    const result = await new MlV2Client({
      baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000,
    }).deliverRepositoryIndex(repositoryJob);
    assert.equal(result.accepted, true);
    assert.deepEqual(result.response_body, repositoryResponse());
  });
  const body = received as unknown as Record<string, unknown>;
  assert.equal(body.schema_version, 2);
  assert.deepEqual(Object.keys(body).sort(), [
    'content_version', 'job_id', 'repo_id', 'repository', 'schema_version',
  ]);
});

test('repository-index response validator enforces version identity and strict artifact shape', () => {
  assert.deepEqual(parseMlRepositoryIndexResponse(repositoryResponse(), repositoryJob), repositoryResponse());
  assert.throws(
    () => parseMlRepositoryIndexResponse(repositoryResponse({ content_version: 2 }), repositoryJob),
    /did not match/,
  );
  assert.throws(
    () => parseMlRepositoryIndexResponse({ ...repositoryResponse(), unexpected: true }, repositoryJob),
    /violated the v2 envelope/,
  );
  assert.throws(() => parseMlRepositoryIndexResponse(repositoryResponse({
    card_summary: { ...repositoryResponse().card_summary, summary: 'x'.repeat(361) },
  }), repositoryJob), /invalid bounded content/);
  assert.throws(() => parseMlRepositoryIndexResponse(repositoryResponse({
    card_summary: {
      ...repositoryResponse().card_summary,
      source: 'description_fallback',
    },
  }), repositoryJob), /invalid bounded content/);
  const fallbackResponse = repositoryResponse({
    card_summary: {
      ...repositoryResponse().card_summary,
      model_version: ML_DESCRIPTION_FALLBACK_MODEL_VERSION,
      source: 'description_fallback',
    },
  });
  assert.deepEqual(parseMlRepositoryIndexResponse(fallbackResponse, repositoryJob), fallbackResponse);
  const quotedSentenceResponse = repositoryResponse({
    card_summary: {
      ...repositoryResponse().card_summary,
      summary: 'Teams call it "Review Workspace." It helps developers evaluate repositories quickly.',
    },
  });
  assert.deepEqual(
    parseMlRepositoryIndexResponse(quotedSentenceResponse, repositoryJob),
    quotedSentenceResponse,
  );
  assert.throws(() => parseMlRepositoryIndexResponse(repositoryResponse({
    card_summary: {
      ...repositoryResponse().card_summary,
      highlights: ['one', 'two', 'three', 'four'],
    },
  }), repositoryJob), /invalid bounded content/);
  assert.throws(() => parseMlRepositoryIndexResponse(repositoryResponse({
    card_summary: {
      ...repositoryResponse().card_summary,
      summary: 'This is only one complete sentence.',
    },
  }), repositoryJob), /invalid bounded content/);
  assert.throws(() => parseMlRepositoryIndexResponse(repositoryResponse({
    card_summary: {
      ...repositoryResponse().card_summary,
      summary: 'Sentence one. Sentence two. Sentence three. Sentence four.',
    },
  }), repositoryJob), /invalid bounded content/);
  assert.throws(() => parseMlRepositoryIndexResponse(
    repositoryResponse(),
    { ...repositoryJob, repository: { ...repositoryJob.repository, content_hash: '' } },
  ), /content hash/);
  assert.throws(() => parseMlRepositoryIndexResponse(repositoryResponse({
    card_summary: {
      ...repositoryResponse().card_summary,
      highlights: ['x'.repeat(97)],
    },
  }), repositoryJob), /invalid bounded content/);
});

test('repository-index response validator rejects README-copy, command, and section leakage', () => {
  const copied = 'Canonical Markdown stays separate. '.repeat(4).trim();
  const copiedJob = {
    ...repositoryJob,
    repository: { ...repositoryJob.repository, readme: `# Repository\n\n${copied}\n` },
  };
  for (const summary of [
    copied,
    'Run npm install package-name to install it before starting the application.',
    'Installation instructions: download the project and configure it locally.',
    'License: MIT. Contributors may reuse the project under those terms.',
    'Contributing: open a pull request after changing the implementation.',
    'A concise project summary with `inline code` that must not reach a card.',
    'Run brew install package-name to prepare the project. Then start the application normally.',
    'API reference: every endpoint is listed here. Follow these instructions to configure authentication.',
    'Use the [project website](https://example.com) for details. The repository targets developers.',
    '- Fast project discovery. - Personalized repository context.',
  ]) {
    assert.throws(() => parseMlRepositoryIndexResponse(repositoryResponse({
      card_summary: { ...repositoryResponse().card_summary, summary },
    }), copiedJob), /invalid bounded content/);
  }
  assert.throws(() => parseMlRepositoryIndexResponse(repositoryResponse({
    card_summary: {
      ...repositoryResponse().card_summary,
      highlights: ['Run yarn add package-name'],
    },
  }), copiedJob), /invalid bounded content/);
});

test('ordinary documentation tools and abbreviated prose remain valid summary responses', () => {
  for (const summary of [
    'This tool generates API documentation from source code. Teams can publish a searchable site.',
    'This changelog tool summarizes releases from commit history. Teams can share project updates.',
    'It supports common formats, e.g. JSON and YAML. Developers can extend it, e.g. with custom parsers.',
    'It supports common formats, i.e. JSON and YAML. Dr. Smith built extensible parsers for developers.',
  ]) {
    const expected = repositoryResponse({ card_summary: { ...repositoryResponse().card_summary, summary } });
    assert.deepEqual(parseMlRepositoryIndexResponse(expected, repositoryJob), expected);
  }
});

test('inline abbreviations do not inflate the summary sentence count', () => {
  for (const summary of [
    'It compares SQL vs. NoSQL stores. Teams can inspect latency vs. throughput tradeoffs.',
    'It supports JSON, YAML, etc. for configuration. Teams can extend the available formats. Developers can add parsers.',
    'It indexes U.S. projects. Teams can browse U.K. repositories. Developers can filter results.',
    'It supports JSON, YAML, etc. Teams can extend the available formats.',
  ]) {
    const expected = repositoryResponse({ card_summary: { ...repositoryResponse().card_summary, summary } });
    assert.deepEqual(parseMlRepositoryIndexResponse(expected, repositoryJob), expected, summary);
  }
});

test('abbreviations do not bypass summary sentence limits or final punctuation', () => {
  for (const summary of [
    'It compares SQL vs. NoSQL stores.',
    'It supports JSON, YAML, etc. for configuration.',
    'It indexes U.S. projects.',
    'It supports JSON, YAML, etc.',
    'It supports JSON, YAML, etc. Teams can extend it. Developers can add parsers. Users can share results.',
    'It compares SQL vs. NoSQL stores. Teams inspect latency vs. throughput tradeoffs',
  ]) {
    assert.throws(() => parseMlRepositoryIndexResponse(repositoryResponse({
      card_summary: { ...repositoryResponse().card_summary, summary },
    }), repositoryJob), /invalid bounded content/, summary);
  }
});

const compatibilityCases = JSON.parse(readFileSync(
  new URL('../fixtures/summary_compatibility.json', import.meta.url), 'utf8',
)) as Array<{ name: string; summary: string; highlights?: string[]; valid: boolean }>;

for (const fixture of compatibilityCases) {
  test(`shared ML summary contract: ${fixture.name}`, () => {
    for (const status of ['applied', 'duplicate', 'current'] as const) {
      const response = repositoryResponse({ status, card_summary: {
        ...repositoryResponse().card_summary,
        summary: fixture.summary,
        highlights: fixture.highlights ?? [],
      } });
      if (fixture.valid) {
        assert.deepEqual(parseMlRepositoryIndexResponse(response, repositoryJob), response);
      } else {
        assert.throws(() => parseMlRepositoryIndexResponse(response, repositoryJob), /invalid bounded content/);
      }
    }
  });
}

test('real Python pipeline artifacts are accepted by Node HTTP delivery', {
  skip: !process.env.WEAVE_ML_ROOT || !process.env.WEAVE_ML_PYTHON,
}, async () => {
  const artifacts = JSON.parse(execFileSync(process.env.WEAVE_ML_PYTHON!, ['-c', `
import json
from pathlib import Path
from summarization.pipeline import CardSummaryPipeline
cases = json.loads(Path('tests/fixtures/summary_compatibility.json').read_text())
artifacts = []
for case in cases:
    if not case['valid']:
        continue
    class Provider:
        def generate(self, *args, **kwargs):
            return json.dumps({'summary': case['summary'], 'highlights': case.get('highlights', [])})
    repo = {'full_name': 'weave/compatibility', 'description': 'A focused developer tool.' if len(case['summary']) >= 180 else case['summary']}
    pipeline = CardSummaryPipeline(provider=Provider() if len(case['summary']) >= 180 else None)
    artifact = pipeline.summarize(repo, repo)
    if len(case['summary']) >= 180:
        assert artifact.source == 'generated'
    artifacts.append(artifact.model_dump(mode='json'))
print(json.dumps(artifacts))
`], { cwd: process.env.WEAVE_ML_ROOT, encoding: 'utf8', timeout: 30_000 })) as
    MlRepositoryIndexResponse['card_summary'][];
  for (const card_summary of artifacts) {
    for (const status of ['applied', 'duplicate', 'current'] as const) {
      const expected = repositoryResponse({ status, card_summary });
      await withServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(expected));
      }, async (url) => {
        const result = await new MlV2Client({
          baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000,
        }).deliverRepositoryIndex(repositoryJob);
        assert.equal(result.accepted, true, JSON.stringify(result));
        assert.equal(result.retryable, false);
        assert.deepEqual(result.response_body, expected);
      });
    }
  }
});

test('repository-index transport preserves HTTP failures without requiring JSON', async () => {
  for (const [status, retryable, text] of [
    [429, true, 'rate limited'], [503, true, '<html>upstream unavailable</html>'],
    [400, false, 'bad repository payload'],
  ] as const) {
    await withServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'text/plain', 'retry-after': '2' });
      response.end(text);
    }, async (url) => {
      const result = await new MlV2Client({
        baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000,
      }).deliverRepositoryIndex(repositoryJob);
      assert.equal(result.accepted, false);
      assert.equal(result.status_code, status);
      assert.equal(result.retryable, retryable);
      assert.equal(result.retry_after_ms, 2_000);
      assert.equal(result.detail, text);
    });
  }
});

test('description fallback may repeat its canonical description even when README repeats it', () => {
  const description = 'This repository helps engineering teams evaluate unfamiliar projects with focused context and clear discovery guidance.';
  const fallbackJob = {
    ...repositoryJob,
    repository: {
      ...repositoryJob.repository,
      description,
      readme: `# Project\n\n${description}`,
    },
  };
  const fallback = repositoryResponse({
    card_summary: {
      ...repositoryResponse().card_summary,
      summary: `${description} It is intended for TypeScript developers.`,
      model_version: ML_DESCRIPTION_FALLBACK_MODEL_VERSION,
      source: 'description_fallback',
    },
  });
  assert.deepEqual(parseMlRepositoryIndexResponse(fallback, fallbackJob), fallback);
  assert.throws(() => parseMlRepositoryIndexResponse(repositoryResponse({
    card_summary: {
      ...fallback.card_summary,
      model_version: 'provider-model',
      source: 'generated',
    },
  }), fallbackJob), /invalid bounded content/);
});

test('repository-index transport terminally rejects malformed successful responses', async () => {
  await withServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(repositoryResponse({ repo_id: '00000000-0000-4000-8000-000000000099' })));
  }, async (url) => {
    const result = await new MlV2Client({
      baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000,
    }).deliverRepositoryIndex(repositoryJob);
    assert.equal(result.accepted, false);
    assert.equal(result.retryable, false);
    assert.match(result.detail ?? '', /did not match/);
  });
});

test('repository-index transport terminally rejects invalid JSON and oversized successful responses', async () => {
  for (const [body, maxResponseBytes, message] of [
    ['not-json', 10_000, /invalid JSON/],
    [JSON.stringify({ padding: 'x'.repeat(1_000) }), 100, /size limit/],
  ] as const) {
    await withServer((_req, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    }, async (url) => {
      const result = await new MlV2Client({
        baseUrl: url,
        internalSecret: 'test',
        timeoutMs: 500,
        maxResponseBytes,
      }).deliverRepositoryIndex(repositoryJob);
      assert.equal(result.accepted, false);
      assert.equal(result.retryable, false);
      assert.match(result.detail ?? '', message);
    });
  }
});

test('ML recommendation client rejects invalid contracts', async () => {
  await withServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ schema_version: 1, items: [] }));
  }, async (url) => {
    const client = new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000 });
    await assert.rejects(client.generate({
      schema_version: 2, generation_id: '00000000-0000-4000-8000-000000000001',
      user_id: '00000000-0000-4000-8000-000000000002', feed_version: 1, limit: 10,
      exclude_repo_ids: [], context: { cold_start: false },
    }), /violated the v2 envelope/);
  });
});

test('ML recommendation client still requires JSON', async () => {
  await withServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('not-json');
  }, async (url) => {
    const client = new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000 });
    await assert.rejects(client.generate({
      schema_version: 2, generation_id: '00000000-0000-4000-8000-000000000001',
      user_id: '00000000-0000-4000-8000-000000000002', feed_version: 1, limit: 10,
      exclude_repo_ids: [], context: { cold_start: false },
    }), /invalid JSON/);
  });
});

test('ML recommendation client rejects an empty successful result', async () => {
  const generationId = '00000000-0000-4000-8000-000000000001';
  const userId = '00000000-0000-4000-8000-000000000002';
  await withServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      schema_version: 2,
      generation_id: generationId,
      user_id: userId,
      feed_version: 1,
      model_version: 'test-model',
      embedding_version: 'test-embedding',
      items: [],
    }));
  }, async (url) => {
    const client = new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000 });
    await assert.rejects(client.generate({
      schema_version: 2,
      generation_id: generationId,
      user_id: userId,
      feed_version: 1,
      limit: 10,
      exclude_repo_ids: [],
      context: { cold_start: false },
    }), /contained no items/);
  });
});

test('ML recommendation client rejects non-canonical repository IDs', async () => {
  const generationId = '00000000-0000-4000-8000-000000000001';
  const userId = '00000000-0000-4000-8000-000000000002';
  await withServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      schema_version: 2,
      generation_id: generationId,
      user_id: userId,
      feed_version: 1,
      model_version: 'test-model',
      embedding_version: 'test-embedding',
      items: [{ repo_id: 'owner/repository', score: 0.9, source: 'semantic' }],
    }));
  }, async (url) => {
    const client = new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000 });
    await assert.rejects(client.generate({
      schema_version: 2,
      generation_id: generationId,
      user_id: userId,
      feed_version: 1,
      limit: 10,
      exclude_repo_ids: [],
      context: { cold_start: false },
    }), /invalid or duplicate item/);
  });
});

test('ML transport turns timeout/network failures into retryable delivery results', async () => {
  await withServer((_req, response) => setTimeout(() => response.end('{}'), 100), async (url) => {
    const result = await new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 10, maxResponseBytes: 10_000 })
      .deliverFeedback(feedback);
    assert.equal(result.accepted, false);
    assert.equal(result.retryable, true);
    assert.equal(result.status_code, 0);
  });
});

test('durable delivery uses its longer timeout without weakening read timeouts', async () => {
  await withServer((_req, response) => setTimeout(() => {
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end('{"accepted":true}');
  }, 30), async (url) => {
    const result = await new MlV2Client({
      baseUrl: url,
      internalSecret: 'test',
      timeoutMs: 10,
      deliveryTimeoutMs: 100,
      maxResponseBytes: 10_000,
    }).deliverFeedback(feedback);
    assert.equal(result.accepted, true);
    assert.equal(result.status_code, 202);
  });
});

test('repository indexing uses its dedicated generation-and-embedding timeout', async () => {
  await withServer((_req, response) => setTimeout(() => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(repositoryResponse()));
  }, 30), async (url) => {
    const result = await new MlV2Client({
      baseUrl: url,
      internalSecret: 'test',
      timeoutMs: 5,
      deliveryTimeoutMs: 10,
      repositoryIndexTimeoutMs: 100,
      maxResponseBytes: 10_000,
    }).deliverRepositoryIndex(repositoryJob);
    assert.equal(result.accepted, true);
    assert.equal(result.status_code, 200);
  });
});
