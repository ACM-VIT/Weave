import crypto from 'node:crypto';

type CursorPayload = {
  schema: 1;
  user_id: string;
  session_id: string;
  feed_version: string;
  offset: number;
};

export class InvalidFeedCursorError extends Error {
  constructor(message = 'Feed cursor is invalid or stale.') {
    super(message);
    this.name = 'InvalidFeedCursorError';
  }
}

export class StaleFeedCursorError extends InvalidFeedCursorError {
  readonly code = 'FEED_CURSOR_STALE';
}

export class FeedCursorCodec {
  constructor(private readonly secret: string | undefined) {}

  private key(): string {
    if (!this.secret) throw new Error('JWT_SECRET is required for feed cursors.');
    return this.secret;
  }

  encode(input: Omit<CursorPayload, 'schema'>): string {
    const body = Buffer.from(JSON.stringify({ schema: 1, ...input } satisfies CursorPayload)).toString('base64url');
    const signature = crypto.createHmac('sha256', this.key()).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  decode(cursor: string, expected: Omit<CursorPayload, 'schema' | 'offset'>): number {
    try {
      const [body, signature, extra] = cursor.split('.');
      if (!body || !signature || extra) throw new InvalidFeedCursorError();
      const expectedSignature = crypto.createHmac('sha256', this.key()).update(body).digest();
      const suppliedSignature = Buffer.from(signature, 'base64url');
      if (suppliedSignature.length !== expectedSignature.length
        || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) throw new InvalidFeedCursorError();
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<CursorPayload>;
      if (payload.schema !== 1 || payload.user_id !== expected.user_id
        || payload.session_id !== expected.session_id
        || typeof payload.feed_version !== 'string' || !/^\d+$/.test(payload.feed_version)
        || !Number.isInteger(payload.offset) || Number(payload.offset) < 0 || Number(payload.offset) > 32_767) {
        throw new InvalidFeedCursorError();
      }
      if (payload.feed_version !== expected.feed_version) {
        if (BigInt(payload.feed_version) < BigInt(expected.feed_version)) throw new StaleFeedCursorError();
        throw new InvalidFeedCursorError();
      }
      return Number(payload.offset);
    } catch (error) {
      if (error instanceof InvalidFeedCursorError) throw error;
      throw new InvalidFeedCursorError();
    }
  }
}
