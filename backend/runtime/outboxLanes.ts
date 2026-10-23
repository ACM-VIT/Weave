export const OUTBOX_LANES = ['feedback', 'feedback-retry', 'onboard', 'repository'] as const;
export type OutboxLane = typeof OUTBOX_LANES[number];

export function outboxTaskName(lane: OutboxLane): string {
  return lane === 'feedback' ? 'ml-outbox' : `ml-outbox-${lane}`;
}
