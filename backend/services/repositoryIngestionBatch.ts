import type { RepositoryUpsert } from '../contracts/ingestion.v2.js';
import { normalizeCanonicalRepositoryReadme } from './mlRepositoryPayloadService.js';

export const MAX_INGESTION_REPOSITORIES = 100;
const MAX_BATCH_REPOSITORIES = 25;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;

export interface RepositoryObservation {
  repository: RepositoryUpsert;
  order: number;
}

/** Keep every observation, but never send the same conflict key twice in one INSERT. */
export function planRepositoryObservationBatches(input: RepositoryUpsert[]): RepositoryObservation[][] {
  if (input.length < 1 || input.length > MAX_INGESTION_REPOSITORIES) {
    throw new Error(`Repository ingestion requires 1-${MAX_INGESTION_REPOSITORIES} observations.`);
  }
  const ordered = input.map((repository, order) => ({
    repository: normalizeCanonicalRepositoryReadme(repository), order,
  })).sort((left, right) => {
    const a = BigInt(left.repository.github_id), b = BigInt(right.repository.github_id);
    return a < b ? -1 : a > b ? 1 : left.order - right.order;
  }).map((observation, order) => ({ ...observation, order }));
  const byGithubId = new Map<string, RepositoryObservation[]>();
  for (const observation of ordered) {
    const id = BigInt(observation.repository.github_id).toString();
    const observations = byGithubId.get(id) ?? [];
    observations.push(observation);
    byGithubId.set(id, observations);
  }
  const batches: RepositoryObservation[][] = [];
  let remaining = ordered.length;
  while (remaining > 0) {
    let batch: RepositoryObservation[] = [];
    let bytes = 2;
    for (const observations of byGithubId.values()) {
      const observation = observations.shift();
      if (!observation) continue;
      const size = Buffer.byteLength(JSON.stringify(observation.repository), 'utf8') + 1;
      if (size + 2 > MAX_BATCH_BYTES) throw new Error('Repository observation exceeds the staging byte limit.');
      if (batch.length >= MAX_BATCH_REPOSITORIES || bytes + size > MAX_BATCH_BYTES) {
        batches.push(batch);
        batch = [];
        bytes = 2;
      }
      batch.push(observation);
      bytes += size;
      remaining--;
    }
    if (batch.length > 0) batches.push(batch);
  }
  return batches;
}
