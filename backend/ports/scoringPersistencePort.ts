import type { CaptureRetentionPolicy, ScoringPersistenceResult } from '../contracts/scoringCapture.js';
import type { ValidatedScoringGeneration } from '../services/scoringCaptureValidation.js';

export interface ScoringPersistencePort {
  /** One private SQL commit must finish before any captured queue publication. */
  persist(generation: ValidatedScoringGeneration, policy: CaptureRetentionPolicy): Promise<ScoringPersistenceResult>;
}
