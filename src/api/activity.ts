import { apiV2, apiV2Raw } from './client';
import type { FeedbackAction } from '../constants/feedbackActions';
import { createUuid, getAppSessionId } from '../utils/uuid';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type { FeedbackAction } from '../constants/feedbackActions';

export type QueuedActivity = {
  event_id: string;
  impression_event_id?: string | null;
  session_id: string;
  client_occurred_at: string;
  repo_id: string;
  action: FeedbackAction;
  dwell_seconds?: number;
  serve_id?: string | null;
  position?: number | null;
};

export type ActivityInput = Omit<QueuedActivity, 'event_id' | 'session_id' | 'client_occurred_at'>
  & Partial<Pick<QueuedActivity, 'event_id' | 'session_id' | 'client_occurred_at'>>;

export type InteractionEventV2 = {
  event_id: string;
  impression_event_id?: string | null;
  schema_version: 2;
  session_id: string;
  serve_id: string | null;
  repo_id: string;
  position: number | null;
  event_type: FeedbackAction;
  dwell_ms: number | null;
  client_occurred_at: string;
  context: { client: 'expo'; source: 'feed' | 'product' };
};

export type InteractionBatchResultV2 = {
  accepted: number;
  duplicates: number;
  feed_version: string;
  results: {
    event_id: string;
    status: 'accepted' | 'duplicate';
    feedback_version?: string;
  }[];
};

export function prepareQueuedActivity(event: ActivityInput): QueuedActivity {
  if (!UUID_PATTERN.test(event.repo_id)) throw new Error('Activity repo_id must be a UUID.');
  if (event.serve_id && !UUID_PATTERN.test(event.serve_id)) {
    throw new Error('Activity serve_id must be a UUID.');
  }
  if (event.position !== undefined && event.position !== null
    && (!Number.isInteger(event.position) || event.position < 0)) {
    throw new Error('Activity position must be a non-negative integer.');
  }
  if(event.impression_event_id!==undefined&&event.impression_event_id!==null
    &&(typeof event.impression_event_id!=='string'||!UUID_PATTERN.test(event.impression_event_id)||event.action==='impression'||!event.serve_id||event.position==null)) {
    throw new Error('Activity impression_event_id requires a qualified feed impression reference.');
  }
  return {
    ...event,
    event_id: event.event_id ?? createUuid(),
    session_id: event.session_id ?? getAppSessionId(),
    client_occurred_at: event.client_occurred_at ?? new Date().toISOString(),
  };
}

export function toInteractionEventV2(event: QueuedActivity): InteractionEventV2 {
  return {
    event_id: event.event_id,
    ...('impression_event_id' in event?{impression_event_id:event.impression_event_id}:{}),
    schema_version: 2,
    session_id: event.session_id,
    serve_id: event.serve_id ?? null,
    repo_id: event.repo_id,
    position: event.position ?? null,
    event_type: event.action,
    dwell_ms: event.action === 'dwell'
      ? Math.min(300_000, Math.max(3_000, Math.round((event.dwell_seconds ?? 3) * 1_000)))
      : null,
    client_occurred_at: event.client_occurred_at,
    context: { client: 'expo', source: event.serve_id ? 'feed' : 'product' },
  };
}

export async function getSavedRepos(_userId: string, token: string, limit = 20, offset = 0) {
  const data = await apiV2<{ items: Record<string, unknown>[] }>(`/repositories/saved?limit=${limit}&offset=${offset}`, {}, token);
  return data.items.map((repository) => ({
    activity_id: `saved-${String(repository.repo_id)}`,
    repo_id: repository.repo_id,
    is_saved: true,
    repo: { ...repository, repo_name: repository.name },
  }));
}

export async function sendBatchedActivity(events: ActivityInput[], token: string) {
  if (events.length === 0) return;
  if (events.length > 50) throw new RangeError('Activity batches cannot contain more than 50 events.');
  const payload = events.map(prepareQueuedActivity).map(toInteractionEventV2);
  const { data } = await apiV2Raw<InteractionBatchResultV2>('/interactions/batch', {
    method: 'POST', body: JSON.stringify({ events: payload }),
  }, token);
  return data;
}
