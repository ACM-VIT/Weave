import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import type { OutboxTransportPort } from '../ports/outboxTransportPort.js';

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
  ) {}

  async repair(userId: string): Promise<bigint> {
    if (!this.persistence.getMlOnboardingJob) {
      throw new PersonaRepairError('Persona repair persistence is unavailable.');
    }
    const job = await this.persistence.getMlOnboardingJob(userId);
    if (!job) {
      throw new PersonaRepairError('The completed user profile has no embedding context.');
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
