import crypto from 'node:crypto';
import { isValidUuid } from './validators.js';

export type ProductPageScope = {
  endpoint: 'profile-repositories' | 'collections' | 'boards' | 'collection-repositories' | 'board-repositories';
  viewer: string;
  resource: string;
  selection: string | null;
  sort: string;
};
type Position = { timestamp: string; secondary: string; id: string };
export type ProductPage = { scope: ProductPageScope; limit: number; after: Position | null };
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const invalid = () => Object.assign(new Error('Invalid keyset pagination parameters or cursor.'), { statusCode: 400 });

function secret(): string {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required for product cursors.');
  return process.env.JWT_SECRET;
}
function signature(body: string): Buffer {
  return crypto.createHmac('sha256', secret()).update('product-keyset-v1:').update(body).digest();
}
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !timestampPattern.test(value)) return false;
  // Validate calendar fields without using JS's millisecond value as the SQL boundary.
  const milliseconds = value.slice(0, 23) + 'Z';
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === milliseconds;
}

/** null means the legacy, complete-response contract. Never silently truncate it. */
export function readProductPage(query: Record<string, unknown>, scope: ProductPageScope): ProductPage | null {
  if (query.pagination === undefined) {
    if (query.cursor !== undefined) throw invalid();
    return null;
  }
  if (query.pagination !== 'keyset' || query.offset !== undefined) throw invalid();
  const rawLimit = query.limit === undefined ? '25' : query.limit;
  if (typeof rawLimit !== 'string' || !/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) throw invalid();
  const page: ProductPage = { scope, limit: Number(rawLimit), after: null };
  if (query.cursor === undefined) return page;
  const cursor = query.cursor;
  if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw invalid();
  const [body, mac] = cursor.split('.') as [string, string];
  const supplied = Buffer.from(mac, 'base64url');
  const expected = signature(body);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)
    || supplied.toString('base64url') !== mac) throw invalid();
  try {
    const bytes = Buffer.from(body, 'base64url');
    if (bytes.toString('base64url') !== body) throw invalid();
    const payload = JSON.parse(bytes.toString('utf8'));
    if (!payload || payload.version !== 1 || !payload.scope
      || Object.entries(scope).some(([key, value]) => payload.scope[key] !== value)
      || !validTimestamp(payload.position?.timestamp) || !validTimestamp(payload.position?.secondary)
      || typeof payload.position?.id !== 'string' || !isValidUuid(payload.position.id)) throw invalid();
    page.after = payload.position;
    return page;
  } catch { throw invalid(); }
}

/** SQL must supply exact UTC microseconds as text, not a driver-parsed Date. */
export function productPageResult(rows: Record<string, unknown>[], page: ProductPage | null, idField: string) {
  const hasMore = page !== null && rows.length > page.limit;
  const selected = page ? rows.slice(0, page.limit) : rows;
  let nextCursor: string | null = null;
  if (hasMore && page) {
    const last = selected[selected.length - 1]!;
    const position = { timestamp: last.__page_timestamp, secondary: last.__page_secondary, id: last[idField] };
    if (!validTimestamp(position.timestamp) || !validTimestamp(position.secondary) || typeof position.id !== 'string' || !isValidUuid(position.id)) {
      throw new Error('Invalid product pagination position returned by database.');
    }
    const body = Buffer.from(JSON.stringify({ version: 1, scope: page.scope, position })).toString('base64url');
    nextCursor = `${body}.${signature(body).toString('base64url')}`;
  }
  const items = selected.map(({ __page_timestamp, __page_secondary, ...row }) => row);
  return page ? { items, next_cursor: nextCursor, has_more: hasMore } : { items };
}
