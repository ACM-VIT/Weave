import type { InteractionBatchResultV2, QueuedActivity } from '../api/activity';

export const ACTIVITY_BATCH_LIMIT = 50;

const FEED_INVALIDATING_ACTIONS = new Set<QueuedActivity['action']>([
  'like',
  'unlike',
  'dislike',
  'undislike',
  'save',
  'unsave',
]);

export function nextActivityBatch(events: readonly QueuedActivity[]): QueuedActivity[] {
  return events.slice(0, ACTIVITY_BATCH_LIMIT);
}

export function applyActivityAcknowledgement(
  queued: readonly QueuedActivity[],
  sentBatch: readonly QueuedActivity[],
  result: InteractionBatchResultV2,
): {
  remaining: QueuedActivity[];
  acknowledgedIds: Set<string>;
  invalidatesFeed: boolean;
} {
  const sentById = new Map(sentBatch.map((event) => [event.event_id, event]));
  const acknowledgedIds = new Set<string>();
  let invalidatesFeed = false;

  for (const acknowledgement of result.results ?? []) {
    if (acknowledgement.status !== 'accepted' && acknowledgement.status !== 'duplicate') continue;
    const event = sentById.get(acknowledgement.event_id);
    if (!event) continue;
    acknowledgedIds.add(event.event_id);
    if (FEED_INVALIDATING_ACTIONS.has(event.action)) invalidatesFeed = true;
  }

  return {
    remaining: queued.filter((event) => !acknowledgedIds.has(event.event_id)),
    acknowledgedIds,
    invalidatesFeed,
  };
}
