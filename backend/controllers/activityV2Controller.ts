import type { Response } from 'express';

import type { AuthRequest } from '../middlewares/authMiddleware.js';
import { processInteractionBatchV2 } from '../services/activityV2Service.js';
import { getV2FeatureFlags } from '../config/features.js';
import { isInteractionEventV2 } from '../utils/interactionValidation.js';

export async function processInteractionsV2(req: AuthRequest, res: Response): Promise<void> {
  if (!getV2FeatureFlags().DB_SCHEMA_V2_WRITES) {
    res.status(404).json({ error: 'Interaction v2 writes are disabled.' }); return;
  }
  const userId = req.user?.userId;
  const events = req.body?.events;
  if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
  if (!Array.isArray(events) || events.length < 1 || events.length > 50 || !events.every(isInteractionEventV2)) {
    res.status(400).json({ error: 'Invalid v2 interaction batch.' }); return;
  }
  if (Buffer.byteLength(JSON.stringify(req.body)) > 256_000) {
    res.status(413).json({ error: 'Interaction batch exceeds 256 KB.' }); return;
  }
  try {
    res.status(202).json(await processInteractionBatchV2(userId, events));
  } catch (error) {
    console.error('[ActivityV2Controller] Transaction failed:', error);
    res.status(409).json({ error: error instanceof Error ? error.message : 'Interaction transaction failed.' });
  }
}
