const TERMINAL_REFRESH_STATUSES = new Set([401, 403, 404]);

export function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export function isTerminalRefreshError(error: unknown): boolean {
  const status = httpStatus(error);
  return status !== undefined && TERMINAL_REFRESH_STATUSES.has(status);
}

export function isTerminalRefreshStatus(status: number): boolean {
  return TERMINAL_REFRESH_STATUSES.has(status);
}
