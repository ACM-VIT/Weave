// A provider observation is valid only for the unlink generation read before it.
// Keep terminal rows: deleting them would allow a null -> unlink -> null ABA race.
export interface GithubIdentityFence { operationId: string; status: string; providerIdentityId?: string | null }
export function githubIdentityFenceMatches(
  observed: GithubIdentityFence | null | undefined,
  current: GithubIdentityFence | null,
  freshProviderIdentityId?: string | null,
): boolean {
  if (!current) return observed == null;
  if (!observed || observed.operationId !== current.operationId) return false;
  const target = current.providerIdentityId;
  if (target) {
    // A different immutable credential survives an old-target DELETE. Its
    // fresh observation remains valid across prepared -> done of this same op.
    return observed.providerIdentityId === target && Boolean(freshProviderIdentityId)
      && freshProviderIdentityId !== target;
  }
  // Legacy prepared rows have no credential target. Never infer it from a
  // numeric GitHub subject or bypass that unresolved operation.
  return current.status !== 'prepared' && observed.status === current.status;
}
