import type { Request, Response } from 'express';

import { getApplicationRuntime } from '../runtime/applicationRuntime.js';
import { OutboxService } from '../services/outboxService.js';
import { isValidUuid } from '../utils/validators.js';
import { snapshotMetrics } from '../observability/metrics.js';

const outbox = new OutboxService();

export async function readiness(_req: Request, res: Response): Promise<void> {
  const status = await getApplicationRuntime().health();
  res.status(status.healthy ? 200 : 503).json(status);
}

export async function operationsStatus(_req: Request, res: Response): Promise<void> {
  try {
    const runtime = getApplicationRuntime();
    res.status(200).json({ ...(await runtime.health()), outbox: await outbox.status(), metrics: snapshotMetrics() });
  } catch (error) {
    res.status(503).json({ healthy: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function replayOutbox(req: Request, res: Response): Promise<void> {
  const outboxId = String(req.params.outboxId ?? '');
  if (!isValidUuid(outboxId)) { res.status(400).json({ error: 'outboxId must be a UUID.' }); return; }
  const replayed = await outbox.replay(outboxId);
  res.status(replayed ? 202 : 409).json({ outbox_id: outboxId, replayed });
}

export async function supersedeOutbox(req: Request, res: Response): Promise<void> {
  const outboxId = String(req.params.outboxId ?? '');
  if (!isValidUuid(outboxId)) { res.status(400).json({ error: 'outboxId must be a UUID.' }); return; }
  const superseded = await outbox.supersedeObsoleteOnboarding(outboxId);
  res.status(superseded ? 202 : 409).json({ outbox_id: outboxId, superseded });
}
