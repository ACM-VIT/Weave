import type { MlFeedbackBatch } from '../contracts/ml.v2.js';
import { isValidUuid } from '../utils/validators.js';

/** Aggregate counts alone cannot identify accepted members of a partial batch. */
export function acknowledgedFeedbackIds(body: unknown, events: MlFeedbackBatch['events']): Set<string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Missing durable feedback acknowledgement.');
  const value = body as Record<string, unknown>;
  if (value.durable !== true || !Number.isSafeInteger(value.accepted) || !Number.isSafeInteger(value.duplicates)
    || Number(value.accepted) < 0 || Number(value.duplicates) < 0) {
    throw new Error('Invalid durable feedback acknowledgement.');
  }
  const requested = new Set(events.map(event => event.event_id.toLowerCase()));
  const total = Number(value.accepted) + Number(value.duplicates);
  // Compatibility with the previous provider is safe only for exactly one event.
  if (value.acknowledged_event_ids === undefined && events.length === 1 && total === 1) return requested;
  if (!Array.isArray(value.acknowledged_event_ids) || value.acknowledged_event_ids.length > 100
    || total !== value.acknowledged_event_ids.length) throw new Error('Ambiguous feedback acknowledgement.');
  const acknowledged = new Set<string>();
  for (const id of value.acknowledged_event_ids) {
    if (typeof id !== 'string' || !isValidUuid(id) || !requested.has(id.toLowerCase())
      || acknowledged.has(id.toLowerCase())) throw new Error('Unknown or duplicate feedback acknowledgement.');
    acknowledged.add(id.toLowerCase());
  }
  return acknowledged;
}
