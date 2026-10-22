import { validateRepositoryCardSummary } from './mlService.js';

export function storedSummaryArtifact(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(['summary','highlights','source','prompt_version','model_version','format_version']
    .map(key => [key, row[key]]));
}

export function isAcceptedStoredSummary(
  row: Record<string, unknown>,
  repository: { readme?: string | null; description?: string | null },
): boolean {
  try { validateRepositoryCardSummary(storedSummaryArtifact(row), repository); return true; }
  catch { return false; }
}
