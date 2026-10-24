import type { CaptureRetentionPolicy, ScoringPersistenceResult } from '../contracts/scoringCapture.js';
import type { ValidatedScoringGeneration } from '../services/scoringCaptureValidation.js';

export interface ScoringPersistencePort {
  recordWitness(userId: string, generationId: string, event: 'published' | 'stale'): Promise<boolean>;
  reconcilePublicationWitnesses(userIds: readonly string[], limit: number): Promise<number>;
  /** One private SQL commit must finish before any captured queue publication. */
  persist(generation: ValidatedScoringGeneration, policy: CaptureRetentionPolicy): Promise<ScoringPersistenceResult>;
}
