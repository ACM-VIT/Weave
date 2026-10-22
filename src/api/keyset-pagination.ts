export type KeysetPageOptions = {
  /** Integer from 1 to 100; defaults to 25. */
  limit?: number;
  /** Omit on the first request; reuse only with the same endpoint and filters. */
  cursor?: string;
};

export type KeysetPageMetadata = {
  next_cursor: string | null;
  has_more: boolean;
};

export type KeysetPage<T> = KeysetPageMetadata & {
  items: T[];
};

/** Fail closed when an older server ignores the pagination opt-in. */
export function validateKeysetPageResponse(
  data: unknown,
  itemsKey: 'items' | 'repositories' = 'items',
): void {
  const invalid = () => new Error('Unsupported or invalid pagination response.');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
  const page = data as Record<string, unknown>;
  if (!Array.isArray(page[itemsKey]) || typeof page.has_more !== 'boolean') throw invalid();
  if (page.has_more) {
    if (typeof page.next_cursor !== 'string'
      || page.next_cursor.trim().length === 0
      || page.next_cursor.length > 2048) throw invalid();
  } else if (page.next_cursor !== null) {
    throw invalid();
  }
}

/** Explicitly opt in without changing legacy complete-list requests. */
export function keysetPageQuery(options: KeysetPageOptions = {}): string {
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Page limit must be an integer from 1 to 100.');
  }
  let query = `pagination=keyset&limit=${limit}`;
  if (options.cursor !== undefined) {
    if (!options.cursor) throw new Error('Omit the cursor for the first page.');
    query += `&cursor=${encodeURIComponent(options.cursor)}`;
  }
  return query;
}
