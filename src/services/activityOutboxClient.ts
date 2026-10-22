import { prepareQueuedActivity, sendBatchedActivity, type ActivityInput } from '../api/activity';
import { accessTokenOwner } from '../api/access-token-owner';
import { authSessionLifecycle, SessionChangedError } from '../api/session-lifecycle';
import { getStorageItem } from '../utils/storage';
import { DurableActivityOutbox } from './activityOutbox';
import { acknowledgeActivityOutboxEvents, appendActivityOutboxEvent, loadActivityOutbox } from './activityOutboxStorage';

const userOutboxes = new Map<string, DurableActivityOutbox>();

export function getActivityOutbox(userId: string): DurableActivityOutbox {
  const existing = userOutboxes.get(userId);
  if (existing) return existing;

  const outbox = new DurableActivityOutbox({
    session: {
      capture: () => authSessionLifecycle.currentGeneration(),
      assertCurrent: (token, generation) => {
        authSessionLifecycle.assertCurrent(generation);
        if (accessTokenOwner(token) !== userId) throw new SessionChangedError();
      },
    },
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

/** Keep the viewer lease across enqueue/load and token reads on detail actions. */
export async function queueActivityForViewer(userId: string, event: ActivityInput): Promise<void> {
  const generation = authSessionLifecycle.currentGeneration();
  const outbox = getActivityOutbox(userId);
  await outbox.enqueue(event);
  authSessionLifecycle.assertCurrent(generation);
  const token = await getStorageItem('access_token');
  authSessionLifecycle.assertCurrent(generation);
  if (token) await outbox.flush(token, generation);
}
