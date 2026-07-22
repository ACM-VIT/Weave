import { prepareQueuedActivity, sendBatchedActivity } from '../api/activity';
import { DurableActivityOutbox } from './activityOutbox';
import { loadActivityOutbox, persistActivityOutbox } from './activityOutboxStorage';

const userOutboxes = new Map<string, DurableActivityOutbox>();

export function getActivityOutbox(userId: string): DurableActivityOutbox {
  const existing = userOutboxes.get(userId);
  if (existing) return existing;

  const outbox = new DurableActivityOutbox({
    load: () => loadActivityOutbox(userId),
    persist: (events) => persistActivityOutbox(userId, events),
    send: (events, token) => sendBatchedActivity(events, token),
    prepare: prepareQueuedActivity,
  });
  userOutboxes.set(userId, outbox);
  return outbox;
}
