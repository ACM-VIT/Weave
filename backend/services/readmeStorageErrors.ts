/** PostgreSQL and socket errors that can recover without changing source content. */
export function isTransientReadmeStorageError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const { code, cause } = error as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && (code.startsWith('08')
      || ['40001','40P01','55P03','57014','53300','57P01','57P02','57P03',
        'ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','CONNECTION_CLOSED',
        'CONNECTION_ENDED','CONNECT_TIMEOUT'].includes(code))) return true;
    error = cause;
  }
  return false;
}
