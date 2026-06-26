import type { PaginationParams } from '../types/index.js';

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

export function parsePaginationParams(
  query: { limit?: string; offset?: string },
  defaultLimit: number = 10
): PaginationParams | null {
  const limit = query.limit ? parseInt(query.limit, 10) : defaultLimit;
  const offset = query.offset ? parseInt(query.offset, 10) : 0;

  if (isNaN(limit) || isNaN(offset) || limit < 1 || offset < 0) {
    return null;
  }

  return { limit, offset };
}
