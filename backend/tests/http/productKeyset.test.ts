import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { readProductPage, productPageResult, type ProductPageScope } from '../../utils/productKeyset.js';

const scope: ProductPageScope = {
  endpoint: 'following', viewer: '00000000-0000-4000-8000-000000000001',
  resource: '00000000-0000-4000-8000-000000000002', selection: null,
  sort: 'created-desc,kind-asc,id-asc',
};
const id = '00000000-0000-4000-8000-000000000003';
const timestamp = '2026-10-23T00:00:00.123456Z';

test('mixed following cursors retain the identity kind for colliding UUIDs', () => {
  const prior = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'fixture-product-pagination-secret';
  try {
    const page = readProductPage({ pagination: 'keyset', limit: '1' }, scope)!;
    const result = productPageResult([0, 1].map(kind => ({
      __page_timestamp: timestamp, __page_secondary: timestamp,
      __page_id: id, __page_kind: kind, username: kind ? 'profile' : 'registered',
    })), page, '__page_id');
    const next = readProductPage({ pagination: 'keyset', cursor: result.next_cursor }, scope)!;
    assert.deepEqual(next.after, { timestamp, secondary: timestamp, id, kind: 0 });
    assert.deepEqual(result.items, [{ username: 'registered' }]);
  } finally {
    if (prior === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prior;
  }
});

test('following cursors reject missing or invalid kind instead of silently skipping a tied identity', () => {
  const prior = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'fixture-product-pagination-secret';
  try {
    for (const kind of [undefined, -1, 2, '0', null]) {
      const body = Buffer.from(JSON.stringify({ version: 1, scope, position: { timestamp, secondary: timestamp, id, kind } })).toString('base64url');
      const signature = createHmac('sha256', process.env.JWT_SECRET).update('product-keyset-v1:').update(body).digest('base64url');
      assert.throws(() => readProductPage({ pagination: 'keyset', cursor: `${body}.${signature}` }, scope));
    }
  } finally {
    if (prior === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prior;
  }
});
