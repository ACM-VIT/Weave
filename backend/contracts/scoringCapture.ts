/** Internal private storage contract. This is not a public recommendation DTO. */
export interface CaptureRetentionPolicy {
  policyId: string;
  policyVersion: string;
  retentionDays: number;
}

export interface ScoringInputReference {
  generation_id: string;
  repo_id: string;
  record_digest: string;
}

export interface ScoringGenerationSelector {
  userId: string;
  generationId: string;
  feedVersion: bigint;
}

export interface ScoringCandidateSubmission {
  packet: unknown;
  rawHeavyScore: number;
  finalScore: number;
  source: string;
  retrievalScores: Readonly<Record<string, number>>;
}

export interface ScoringPersistenceResult {
  generationId: string;
  expiresAt: string;
  references: readonly ScoringInputReference[];
}
