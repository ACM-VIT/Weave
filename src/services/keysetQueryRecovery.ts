/** Restart rejected cursors; preserve ordinary next-page retries and cached rows. */
export function retryKeysetQuery(query: {
  error: unknown;
  isFetchNextPageError: boolean;
  fetchNextPage: (options: { cancelRefetch: boolean }) => Promise<unknown>;
  refetch: (options: { cancelRefetch: boolean }) => Promise<unknown>;
}): Promise<unknown> {
  const status = query.error && typeof query.error === 'object' && 'status' in query.error
    ? query.error.status : undefined;
  return query.isFetchNextPageError && status !== 400
    ? query.fetchNextPage({ cancelRefetch: false })
    : query.refetch({ cancelRefetch: false });
}
