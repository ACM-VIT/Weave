import { Platform } from 'react-native';

import type { QueuedActivity } from '../api/activity';

const WEB_KEY_PREFIX = 'ghsocial.activity-outbox.v2';
const MAX_PERSISTED_EVENTS = 200;

function safeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9-]/g, '_');
}

function normalize(value: unknown): QueuedActivity[] {
  if (!Array.isArray(value)) return [];
  return value.filter((event): event is QueuedActivity => (
    Boolean(event)
    && typeof event === 'object'
    && typeof event.event_id === 'string'
    && typeof event.client_occurred_at === 'string'
    && typeof event.repo_id === 'string'
    && typeof event.action === 'string'
  )).slice(-MAX_PERSISTED_EVENTS);
}

export async function loadActivityOutbox(userId: string): Promise<QueuedActivity[]> {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return [];
      const value = localStorage.getItem(`${WEB_KEY_PREFIX}.${safeUserId(userId)}`);
      return value ? normalize(JSON.parse(value)) : [];
    }

    const { File, Paths } = await import('expo-file-system');
    const file = new File(Paths.document, `${WEB_KEY_PREFIX}.${safeUserId(userId)}.json`);
    return file.exists ? normalize(JSON.parse(await file.text())) : [];
  } catch (error) {
    console.warn('Could not restore the activity outbox:', error);
    return [];
  }
}

export async function persistActivityOutbox(userId: string, events: QueuedActivity[]): Promise<void> {
  const retained = events.slice(-MAX_PERSISTED_EVENTS);
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return;
      const key = `${WEB_KEY_PREFIX}.${safeUserId(userId)}`;
      if (retained.length === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(retained));
      return;
    }

    const { File, Paths } = await import('expo-file-system');
    const file = new File(Paths.document, `${WEB_KEY_PREFIX}.${safeUserId(userId)}.json`);
    if (retained.length === 0) {
      if (file.exists) file.delete();
      return;
    }
    if (!file.exists) file.create({ intermediates: true });
    file.write(JSON.stringify(retained));
  } catch (error) {
    console.warn('Could not persist the activity outbox:', error);
  }
}
