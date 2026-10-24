import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { RepositoryLabel } from '../../contracts/repositoryLabel.js';
import { TRENDING_FRESHNESS_MS, TrendingSnapshotService } from '../../services/trendingSnapshotService.js';

// This handler fixture injects every data loader; importing the controller must
// not require a real database connection or production credentials.
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const [{ createTrendingHandler }, { sqlClient }] = await Promise.all([
  import('../../controllers/trendingController.js'), import('../../db/index.js'),
]);
test.after(async () => { await sqlClient.end({ timeout: 0 }); });

type Handler = ReturnType<typeof createTrendingHandler>;
async function invoke(handler: Handler) {
  const result = { status: 0, body: '', headers: {} as Record<string, string> };
  const response = {
    set(name: string, value: string) { result.headers[name] = value; return response; },
    removeHeader(name: string) { delete result.headers[name]; return response; },
    vary() { return response; },
    status(value: number) { result.status = value; return response; },
    type() { return response; },
    send(body: string) { result.body = body; return response; },
    json(body: unknown) { return response.send(JSON.stringify(body)); },
  };
  await handler({ query: {}, user: { userId: 'viewer' } } as Parameters<Handler>[0],
    response as unknown as Parameters<Handler>[1]);
  return result;
}

function fixture() {
  let hydrations = 0;
  const service = new TrendingSnapshotService({
    async available() { return [{ period: 'daily', snapshot_id: 'snapshot', captured_at: '2026-10-24T00:00:00Z' }]; },
    async cards() { hydrations++; return [{ repo_id: 'repo', position: 3, likes_count: 2 }]; },
  }, () => 0);
  return { service, hydrations: () => hydrations };
}

test('Trending labels decorate request copies and final validators without contaminating public cache', async () => {
  const { service, hydrations } = fixture();
  const label: RepositoryLabel = { kind: 'trending', rank: 3, period: 'daily', source: 'github-trending',
    observed_at: '2026-10-24T00:00:00Z', expires_at: '2026-10-25T12:00:00Z' };
  const first = await invoke(createTrendingHandler(service, async () => [], () => 0, async ids => {
    assert.deepEqual(ids, ['repo']); return new Map([['repo', label]]);
  }));
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.body).data.items[0].label, label);
  assert.equal(first.headers.ETag, `"${createHash('sha256').update(first.body).digest('hex')}"`);
  const cached = JSON.parse((await service.get()).body).data.items[0];
  assert.equal(cached.label, undefined);
  assert.equal(cached.viewer_saved, undefined, 'viewer state also stays outside public cards');
  const unavailable = await invoke(createTrendingHandler(service, async () => [], () => 0, async () => {
    throw new Error('optional label service unavailable');
  }));
  assert.equal(unavailable.status, 200);
  assert.equal(JSON.parse(unavailable.body).data.items[0].label, null);
  assert.notEqual(unavailable.headers.ETag, first.headers.ETag, 'validator includes the label decoration');
  assert.equal(hydrations(), 1);
});

test('Trending skips optional labels when their budget plus serialization headroom no longer fits', async () => {
  const { service } = fixture();
  let time = 0, labelCalls = 0;
  const result = await invoke(createTrendingHandler(service, async () => {
    time = TRENDING_FRESHNESS_MS - 100; return [];
  }, () => time, async () => { labelCalls++; return new Map(); }));
  assert.equal(result.status, 200, 'optional enrichment must preserve an otherwise timely response');
  assert.equal(labelCalls, 0);
  assert.equal(JSON.parse(result.body).data.items[0].label, undefined);
});
