import { MAX_FEED_SERVE_LOOKUP_BATCH } from '../ports/feedPersistencePort.js';
import type { FeedReconciliationPersistencePort, FeedServeRequest } from '../ports/feedPersistencePort.js';
import { isValidUuid } from '../utils/validators.js';
import type { FeedQueuePort } from '../redis/feedQueue.js';

export class FeedReconciliationWorker {
  constructor(
    private readonly persistence: FeedReconciliationPersistencePort,
    private readonly queue: Pick<FeedQueuePort, 'scanReservations' | 'commit' | 'release' | 'deleteStaleVersions'>,
    private readonly reconcileWithinMs = 15_000,
  ) {}

  async runOnce(): Promise<{ committed: number; released: number }> {
    let committed = 0; let released = 0;
    const requestKey = (request: FeedServeRequest) => `${request.userId.toLowerCase()}:${request.requestId.toLowerCase()}`;
    const seen = new Set<string>();
    const reservations = (await this.queue.scanReservations()).filter(reservation => {
      if (!Number.isFinite(reservation.ttlMs) || reservation.ttlMs < 0 || reservation.ttlMs > this.reconcileWithinMs
        || !isValidUuid(reservation.userId) || !isValidUuid(reservation.requestId) || !reservation.token) return false;
      const key = `${reservation.userId}:${reservation.requestId}:${reservation.version}:${reservation.token}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
          if (await this.queue.commit(reservation.userId, reservation.version, reservation.requestId, reservation.token)) committed++;
        } else if (await this.queue.release(reservation.userId, reservation.version, reservation.requestId, reservation.token)) released++;
        const current = await this.persistence.getFeedVersion(reservation.userId);
        await this.queue.deleteStaleVersions(reservation.userId, current);
      }
    }
    return { committed, released };
  }
}
