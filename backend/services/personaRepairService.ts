import type { ModelLaneAuthorityService } from './modelLaneAuthorityService.js';
import { performance } from 'node:perf_hooks';

import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import type { OutboxTransportPort } from '../ports/outboxTransportPort.js';

export interface PersonaRepairBudget {
  deadline: number;
  minimumRemainingMs: number;
}

export class PersonaRepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonaRepairError';
  }
}

export class PersonaRepairService {
  constructor(
    private readonly persistence: Pick<FeedPersistencePort, 'getMlOnboardingJob' | 'recordMlProfileDelivered'>,
    private readonly transport: Pick<OutboxTransportPort, 'deliverOnboarding'>,
    private readonly orderedProfiles?:ModelLaneAuthorityService,
  ) {}

  async repair(userId: string, budget?: PersonaRepairBudget): Promise<bigint> {
    if(this.orderedProfiles && await this.orderedProfiles.isEnabled(userId))return this.orderedProfiles.ensureProfileReady(userId);
    if (!this.persistence.getMlOnboardingJob) {
      throw new PersonaRepairError('Persona repair persistence is unavailable.');
    }
    const job = await this.persistence.getMlOnboardingJob(userId);
    if (!job) {
      throw new PersonaRepairError('The completed user profile has no embedding context.');
    }
    // The lookup is part of the caller's operation budget. Recheck immediately
    // before starting the non-cancellable delivery so a slow database read
    // cannot launch fresh ML work after the generation deadline.
    if (budget && budget.deadline - performance.now() <= budget.minimumRemainingMs) {
      throw new PersonaRepairError('Feed generation operation budget exhausted before persona delivery.');
    }
    const result = await this.transport.deliverOnboarding(job);
    if (!result.accepted) {
      throw new PersonaRepairError(
        result.detail
          ? `ML persona repair failed (${result.status_code}): ${result.detail}`
          : `ML persona repair failed with status ${result.status_code}.`,
      );
    }
    const profileVersion = BigInt(job.profile_version);
    if (!this.persistence.recordMlProfileDelivered
      || !await this.persistence.recordMlProfileDelivered(userId, profileVersion)) {
      throw new PersonaRepairError('Delivered persona was superseded before durable acknowledgement.');
    }
    return profileVersion;
  }
}
