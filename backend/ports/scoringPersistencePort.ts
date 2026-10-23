import type { CaptureRetentionPolicy, ScoringPersistenceResult } from '../contracts/scoringCapture.js';
import type { ValidatedScoringGeneration } from '../services/scoringCaptureValidation.js';

export interface ScoringPersistencePort {
  /** One private SQL commit must finish before any captured queue publication. */
  recordWitness(userId: string, generationId: string, event: 'published' | 'stale'): Promise<boolean>;
  persist(generation: ValidatedScoringGeneration, policy: CaptureRetentionPolicy): Promise<ScoringPersistenceResult>;
}
