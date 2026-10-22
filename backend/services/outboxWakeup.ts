import type postgres from 'postgres';

export const OUTBOX_WAKE_CHANNEL = 'weave_ml_outbox_ready';
export const PREWARM_WAKE_CHANNEL = 'weave_onboarding_prewarm_ready';

/** PostgreSQL delivers NOTIFY only when this transaction commits, never on rollback. */
export async function notifyOutboxAfterCommit(tx: postgres.TransactionSql): Promise<void> {
  // The channel carries no user, repository, or job payload. Notifications are
  // only hints; the durable outbox and bounded polling remain authoritative.
  await tx`SELECT pg_notify(${OUTBOX_WAKE_CHANNEL}, '')`;
}
