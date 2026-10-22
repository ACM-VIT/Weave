import type { FeedGenerationOutcome, FeedGenerationService } from '../services/feedGenerationService.js';
import type { OnboardingPrewarmService } from '../services/onboardingPrewarmService.js';

/** No unbounded in-memory queue: claim only when this independent lane has capacity. */
export class OnboardingPrewarmWorker {
  constructor(
    private readonly prewarm: OnboardingPrewarmService,
    private readonly generation: FeedGenerationService,
  ) {}

  async runOnce(): Promise<number> {
    const claim = await this.prewarm.claim();
    if (!claim) return 0;
    if (claim === 'superseded') return 1;
    let outcome: FeedGenerationOutcome;
    try {
      outcome = await this.generation.generate(claim.userId, 45, [], 'prewarm', undefined, {
        feedVersion: claim.feedVersion,
        isCurrent: () => this.prewarm.isCurrent(claim),
      });
    } catch (error) {
      await this.prewarm.finish(claim, false, error instanceof Error ? error.name : 'generation_failed');
      throw error;
    }
    // A coalesced generation is not a completion acknowledgement. Keep a
    // durable retry so a crashed/failed lock holder cannot lose the prewarm.
    await this.prewarm.finish(claim, outcome.status === 'generated',
      outcome.status === 'generated' ? undefined : outcome.status);
    return 1;
  }
}
