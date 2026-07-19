import { apiV2, apiV2Raw } from './client';
import type { FeedbackAction } from '../constants/feedbackActions';
import { createUuid, getAppSessionId } from '../utils/uuid';

export type { FeedbackAction } from '../constants/feedbackActions';

export type QueuedActivity = {
  event_id: string;
  client_occurred_at: string;
  repo_id: string;
  action: FeedbackAction;
  dwell_seconds?: number;
  serve_id?: string | null;
  position?: number | null;
};

export type ActivityInput = Omit<QueuedActivity, 'event_id' | 'client_occurred_at'>
  & Partial<Pick<QueuedActivity, 'event_id' | 'client_occurred_at'>>;

export function prepareQueuedActivity(event: ActivityInput): QueuedActivity {
  return {
    ...event,
    event_id: event.event_id ?? createUuid(),
    client_occurred_at: event.client_occurred_at ?? new Date().toISOString(),
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

export async function toggleSaveRepo(_userId: string, repoId: string, token: string) {
  return sendBatchedActivity([prepareQueuedActivity({ repo_id: repoId, action: 'save' })], token);
}

export async function sendBatchedActivity(events: ActivityInput[], token: string) {
  if (events.length === 0) return;
  const payload = events.map(prepareQueuedActivity).map((event) => ({
    event_id: event.event_id,
    schema_version: 2 as const,
    session_id: getAppSessionId(),
    serve_id: event.serve_id ?? null,
    repo_id: event.repo_id,
    position: event.position ?? null,
    event_type: event.action,
    dwell_ms: event.action === 'dwell'
      ? Math.min(300_000, Math.max(3_000, Math.round((event.dwell_seconds ?? 3) * 1_000)))
      : null,
    client_occurred_at: event.client_occurred_at,
    context: { client: 'expo', source: event.serve_id ? 'feed' : 'product' },
  }));
  const { data } = await apiV2Raw('/interactions/batch', {
    method: 'POST', body: JSON.stringify({ events: payload }),
  }, token);
  return data;
}
