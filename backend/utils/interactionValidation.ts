import { INTERACTION_EVENT_TYPES, type InteractionEventV2 } from '../contracts/interactions.v2.js';
import { isValidUuid } from './validators.js';

const eventTypes = new Set<string>(INTERACTION_EVENT_TYPES);

export function isInteractionEventV2(value: unknown): value is InteractionEventV2 {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (event.schema_version !== 2 || typeof event.event_type !== 'string' || !eventTypes.has(event.event_type)) return false;
  if (typeof event.event_id !== 'string' || !isValidUuid(event.event_id)
    || typeof event.session_id !== 'string' || !isValidUuid(event.session_id)
    || typeof event.repo_id !== 'string' || !isValidUuid(event.repo_id)) return false;
  if (event.serve_id !== null && (typeof event.serve_id !== 'string' || !isValidUuid(event.serve_id))) return false;
  if (event.impression_event_id !== undefined && event.impression_event_id !== null
    && (typeof event.impression_event_id!=='string'||!isValidUuid(event.impression_event_id)
      || event.event_type==='impression'||event.serve_id===null||event.position===null)) return false;
  if (event.position !== null && (!Number.isInteger(event.position) || Number(event.position) < 0)) return false;
  if (event.event_type === 'dwell') {
    if (!Number.isInteger(event.dwell_ms) || Number(event.dwell_ms) < 3_000 || Number(event.dwell_ms) > 300_000) return false;
  } else if (event.dwell_ms !== null) return false;
  if (typeof event.client_occurred_at !== 'string' || Number.isNaN(Date.parse(event.client_occurred_at))) return false;
  return !!event.context && typeof event.context === 'object' && !Array.isArray(event.context);
}
