import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedCursorCodec, InvalidFeedCursorError } from '../../services/feedCursor.js';

const codec = new FeedCursorCodec('test-cursor-secret');
const bound = { user_id: 'viewer', session_id: 'session', feed_version: '2' };
const encode = (overrides: Record<string, unknown> = {}) => codec.encode({ ...bound, offset: 10, ...overrides });

test('only authentic correctly bound outdated cursors receive FEED_CURSOR_STALE', () => {
  assert.throws(() => codec.decode(encode({ feed_version: '1' }), bound),
    (error: unknown) => error instanceof InvalidFeedCursorError && (error as { code?: string }).code === 'FEED_CURSOR_STALE');
  for (const cursor of [encode({ user_id: 'other', feed_version: '1' }),
    encode({ session_id: 'other', feed_version: '1' }), encode({ offset: -1, feed_version: '1' }),
    encode({ feed_version: '3' }), encode({ feed_version: 'nonsense' }), 'malformed', `${encode()}.extra`]) {
    assert.throws(() => codec.decode(cursor, bound), (error: unknown) =>
      error instanceof InvalidFeedCursorError && !('code' in error));
  }
  assert.equal(codec.decode(encode(), bound), 10);
});
