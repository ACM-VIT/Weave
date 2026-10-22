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
  const batches: RepositoryObservation[][] = [];
  let batch: RepositoryObservation[] = [];
  let keys = new Set<string>();
  let bytes = 2;
  for (const observation of ordered) {
    const id = BigInt(observation.repository.github_id).toString();
    const size = Buffer.byteLength(JSON.stringify(observation.repository), 'utf8') + 1;
    if (size + 2 > MAX_BATCH_BYTES) throw new Error('Repository observation exceeds the staging byte limit.');
    // Preserve the sequential numeric-ID order, including name releases before
    // a later repository reuses that unique name. Waves would reorder these.
    if (keys.has(id) || batch.length >= MAX_BATCH_REPOSITORIES || bytes + size > MAX_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      keys = new Set<string>();
      bytes = 2;
    }
    batch.push(observation);
    keys.add(id);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
