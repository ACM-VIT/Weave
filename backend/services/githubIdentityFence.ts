// A provider observation is valid only for the unlink generation read before it.
// Keep terminal rows: deleting them would allow a null -> unlink -> null ABA race.
export interface GithubIdentityFence { operationId: string; status: string }
export function githubIdentityFenceMatches(
  observed: GithubIdentityFence | null | undefined,
  current: GithubIdentityFence | null,
): boolean {
  if (!current) return observed == null;
  return observed != null && current.status !== 'prepared'
    && observed.operationId === current.operationId && observed.status === current.status;
}
