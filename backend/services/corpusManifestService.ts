import crypto from 'node:crypto';
import { isValidUuid } from '../utils/validators.js';

export interface CorpusManifestEntry {
  repo_id: string;
  github_id: string;
  full_name: string;
  content_hash: string;
  content_version: number;
  content_updated_at: string;
  source_updated_at: string | null;
}
interface Position { version: 1; as_of: string; expires_at: number; after: string; limit: number }
export class InvalidManifestCursor extends Error {}
export type ManifestReader = (after: string | null, asOf: string, limit: number) => Promise<CorpusManifestEntry[]>;

/** Conservative cutoff inventory, not a retained database snapshot. Rows changed
 * after the cutoff are omitted, leaving acquisition free to refresh them. */
export class CorpusManifestService {
  constructor(private readonly read: ManifestReader, private readonly secret: string,
    private readonly now = Date.now) {}

  async page(limit: number, cursor?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new RangeError('limit must be 1-250');
    if (!this.secret) throw new Error('Manifest cursor signing is not configured');
    const started = this.now();
    const position = cursor ? this.decode(cursor, limit) : {
      version: 1 as const, as_of: new Date(started).toISOString(),
      expires_at: started + 15 * 60_000, after: '', limit,
    };
    const rows = await this.read(position.after || null, position.as_of, limit + 1);
    const items = rows.slice(0, limit);
    return { version: 1, as_of: position.as_of, items,
      next_cursor: rows.length > limit ? this.encode({ ...position, after: items.at(-1)!.repo_id }) : null };
  }
  private encode(position: Position) {
    const body = Buffer.from(JSON.stringify(position)).toString('base64url');
    return `${body}.${this.sign(body).toString('base64url')}`;
  }
  private sign(body: string) {
    return crypto.createHmac('sha256', this.secret).update(`corpus-manifest-v1:${body}`).digest();
  }
  private decode(cursor: string, limit: number): Position {
    try {
      if (cursor.length > 2048) throw new Error();
      const [body, signature, extra] = cursor.split('.');
      if (!body || !signature || extra) throw new Error();
      const supplied = Buffer.from(signature, 'base64url'), expected = this.sign(body);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new Error();
      const value = JSON.parse(Buffer.from(body, 'base64url').toString()) as Position;
      if (value.version !== 1 || value.limit !== limit || !isValidUuid(value.after)
        || !Number.isSafeInteger(value.expires_at) || value.expires_at <= this.now()
        || typeof value.as_of !== 'string' || !Number.isFinite(Date.parse(value.as_of))
        || Date.parse(value.as_of) > this.now() || value.expires_at !== Date.parse(value.as_of) + 15 * 60_000) throw new Error();
      return value;
    } catch { throw new InvalidManifestCursor('Invalid or expired manifest cursor'); }
  }
}
