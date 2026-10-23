import type { InteractionEventV2 } from '../contracts/interactions.v2.js';
import type { MlFeedbackEvent } from '../contracts/ml.v2.js';

export function buildMlFeedbackEvent(
  userId: string,
  event: InteractionEventV2,
  feedbackVersion: string,
): MlFeedbackEvent {
  if (event.event_type === 'impression') {
    throw new Error('Impressions are backend telemetry and cannot be forwarded to ML.');
  }
  return {
    event_id: event.event_id,
    user_id: userId,
    repo_id: event.repo_id,
    feedback_version: feedbackVersion,
    event_type: event.event_type,
    dwell_ms: event.dwell_ms,
    occurred_at: new Date(event.client_occurred_at).toISOString(),
  };
}
