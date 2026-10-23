import assert from 'node:assert/strict';
import test from 'node:test';
import { retryKeysetQuery } from '../src/services/keysetQueryRecovery';

for (const [status, nextPageError, expected] of [[400, true, 'refetch'], [503, true, 'next'], [undefined, true, 'next'], [400, false, 'refetch']] as const) {
  test(`keyset recovery status=${status}, next-page=${nextPageError}`, async () => {
    const calls: string[] = [];
    await retryKeysetQuery({
      error: Object.assign(new Error('fixture'), { status }), isFetchNextPageError: nextPageError,
      fetchNextPage: async options => { assert.equal(options.cancelRefetch, false); calls.push('next'); },
      refetch: async options => { assert.equal(options.cancelRefetch, false); calls.push('refetch'); },
    });
    assert.deepEqual(calls, [expected]);
  });
}
