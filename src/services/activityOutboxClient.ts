import { prepareQueuedActivity, sendBatchedActivity } from '../api/activity';
import { accessTokenOwner } from '../api/access-token-owner';
import { SessionChangedError } from '../api/session-lifecycle';
import { DurableActivityOutbox } from './activityOutbox';
import { acknowledgeActivityOutboxEvents, appendActivityOutboxEvent, loadActivityOutbox } from './activityOutboxStorage';

const userOutboxes = new Map<string, DurableActivityOutbox>();

export function getActivityOutbox(userId: string): DurableActivityOutbox {
  const existing = userOutboxes.get(userId);
  if (existing) return existing;

  const outbox = new DurableActivityOutbox({
    load: () => loadActivityOutbox(userId),
    append: (event) => appendActivityOutboxEvent(userId, event),
    acknowledge: (eventIds) => acknowledgeActivityOutboxEvents(userId, eventIds),
    send: (events, token) => {
      if (accessTokenOwner(token) !== userId) throw new SessionChangedError();
      return sendBatchedActivity(events, token);
    },
    prepare: prepareQueuedActivity,
  });
  userOutboxes.set(userId, outbox);
  return outbox;
}
