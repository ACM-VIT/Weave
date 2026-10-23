import crypto from 'node:crypto';

type CursorPayload = {
  schema: 1;
  user_id: string;
  session_id: string;
  feed_version: string;
  offset: number;
  model_scope?: string;
};
type CursorOwner = Omit<CursorPayload, 'schema' | 'offset' | 'model_scope'>;

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
  private read(cursor: string, expected: CursorOwner): CursorPayload {
    try {
      const [body, signature, extra] = cursor.split('.');
      if (!body || !signature || extra) throw new InvalidFeedCursorError();
      const expectedSignature = crypto.createHmac('sha256', this.key()).update(body).digest();
      const suppliedSignature = Buffer.from(signature, 'base64url');
      if (suppliedSignature.length !== expectedSignature.length
        || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) throw new InvalidFeedCursorError();
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<CursorPayload>;
      if (payload.schema !== 1 || payload.user_id !== expected.user_id || payload.session_id !== expected.session_id
        || typeof payload.feed_version !== 'string' || !/^\d+$/.test(payload.feed_version)
        || !Number.isInteger(payload.offset) || Number(payload.offset) < 0 || Number(payload.offset) > 32_767
        || (payload.model_scope !== undefined && (typeof payload.model_scope !== 'string' || !/^[a-f0-9]{64}$/.test(payload.model_scope)))) {
        throw new InvalidFeedCursorError();
      }
      if (payload.feed_version !== expected.feed_version) {
        if (BigInt(payload.feed_version) < BigInt(expected.feed_version)) throw new StaleFeedCursorError();
        throw new InvalidFeedCursorError();
      }
      return payload as CursorPayload;
    } catch (error) {
      if (error instanceof InvalidFeedCursorError) throw error;
      throw new InvalidFeedCursorError();
    }
  }
  /** Authenticated locator only. Its as-of/state is recovered from durable SQL. */
  modelScope(cursor: string, expected: CursorOwner): string | null {
    return this.read(cursor, expected).model_scope ?? null;
  }
  decode(cursor: string, expected: CursorOwner & { model_scope?: string }): number {
    const payload = this.read(cursor, expected);
    if (payload.model_scope !== expected.model_scope) throw new StaleFeedCursorError();
    return payload.offset;
  }
}
