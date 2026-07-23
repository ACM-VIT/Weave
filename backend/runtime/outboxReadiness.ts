export interface OutboxStatus {
  pending: number;
  claimed: number;
  delivered: number;
  dead: number;
  superseded: number;
  oldest_pending_seconds: number;
}

type OutboxReadinessEnvironment = Partial<Record<'NODE_ENV' | 'OUTBOX_MAX_DEAD', string | undefined>>;

export function getOutboxDeadLimit(
  environment: OutboxReadinessEnvironment = process.env,
): number {
  const rawLimit = environment.OUTBOX_MAX_DEAD?.trim();
  const configured = rawLimit ? Number(rawLimit) : Number.NaN;
  if (Number.isInteger(configured) && configured >= 0) return configured;
  return environment.NODE_ENV === 'production' ? 0 : Number.MAX_SAFE_INTEGER;
}

export function applyOutboxReadinessGate(
  status: OutboxStatus,
  environment: OutboxReadinessEnvironment = process.env,
): OutboxStatus & { healthy: boolean; dead_limit: number } {
  const deadLimit = getOutboxDeadLimit(environment);
  return { healthy: status.dead <= deadLimit, dead_limit: deadLimit, ...status };
}
