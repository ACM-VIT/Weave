export const REFRESH_USER_LOOKUP_TIMEOUT_MS = 10_000;

export class RefreshUserLookupTimeoutError extends Error {
  constructor() {
    super('Refresh user lookup timed out.');
    this.name = 'RefreshUserLookupTimeoutError';
  }
}

/** Only a read-only preflight may be abandoned; never race token mutation. */
export async function withRefreshUserLookupDeadline<T>(lookup: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RefreshUserLookupTimeoutError()), REFRESH_USER_LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([lookup(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
