import { MAX_FEED_SERVE_LOOKUP_BATCH } from '../ports/feedPersistencePort.js';
import type { FeedReconciliationPersistencePort, FeedServeRequest } from '../ports/feedPersistencePort.js';
import { isValidUuid } from '../utils/validators.js';
import type { FeedQueuePort } from '../redis/feedQueue.js';

export class FeedReconciliationWorker {
  constructor(
    private readonly persistence: FeedReconciliationPersistencePort,
    private readonly queue: Pick<FeedQueuePort, 'scanReservations' | 'commit' | 'release' | 'deleteStaleVersions' | 'withScope'>,
    private readonly reconcileWithinMs = 15_000,
  ) {}

  async runOnce(): Promise<{ committed: number; released: number }> {
    let committed = 0; let released = 0;
    const requestKey = (request: FeedServeRequest) => `${request.userId.toLowerCase()}:${request.requestId.toLowerCase()}`;
    const seen = new Set<string>();
    const users = new Map<string,{userId:string;queueScope?:string}>();
    const reservations = (await this.queue.scanReservations()).filter(reservation => {
      if (!Number.isFinite(reservation.ttlMs) || reservation.ttlMs < 0 || reservation.ttlMs > this.reconcileWithinMs
        || !isValidUuid(reservation.userId) || !isValidUuid(reservation.requestId) || !reservation.token) return false;
      if(reservation.queueScope && (!this.queue.withScope || !/^[a-f0-9]{64}$/.test(reservation.queueScope)))return false;
      const key = `${reservation.queueScope??'legacy'}:${reservation.userId}:${reservation.requestId}:${reservation.version}:${reservation.token}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const errors: unknown[] = [];
    try {
      for (let offset = 0; offset < reservations.length; offset += MAX_FEED_SERVE_LOOKUP_BATCH) {
        const batch = reservations.slice(offset, offset + MAX_FEED_SERVE_LOOKUP_BATCH);
        const requests = [...new Map(batch.map(reservation => [requestKey(reservation), {
          userId: reservation.userId, requestId: reservation.requestId,
        }])).values()];
        // A failed lookup throws before any action, never treating an unavailable DB as absence.
        const durable = new Set((await this.persistence.listServedRequests(requests)).map(requestKey));
        for (const reservation of batch) {
          // A batch miss can become committed while earlier reservations are reconciled.
          // Recheck immediately before release, retaining the original per-reservation freshness.
          const served = durable.has(requestKey(reservation))
            || await this.persistence.hasServe(reservation.userId, reservation.requestId);
          if (served) {
            if (await (reservation.queueScope?this.queue.withScope!(reservation.queueScope):this.queue).commit(reservation.userId, reservation.version, reservation.requestId, reservation.token)) committed++;
          } else if (await (reservation.queueScope?this.queue.withScope!(reservation.queueScope):this.queue).release(reservation.userId, reservation.version, reservation.requestId, reservation.token)) released++;
          users.set(`${reservation.userId}:${reservation.queueScope??'legacy'}`,{userId:reservation.userId,queueScope:reservation.queueScope});
        }
      }
    } catch (error) {
      errors.push(error);
    }
    // Completed transitions may have recreated old queues and removed their
    // last reservation. Clean those users even when later processing failed,
    // and do not let one cleanup failure skip the remaining completed users.
    // Each user still gets at most one version lookup/index cleanup per cycle.
    for (const {userId,queueScope} of users.values()) {
      try {
        const current = await this.persistence.getFeedVersion(userId);
        await (queueScope?this.queue.withScope!(queueScope):this.queue).deleteStaleVersions(userId, current);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Feed reconciliation and cleanup failed.');
    return { committed, released };
  }
}
