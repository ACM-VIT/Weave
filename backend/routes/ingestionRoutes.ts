import { Router } from 'express';

import { ingestTrendingSnapshot, upsertRepositories } from '../controllers/ingestionController.js';
import { requireInternalSecret } from '../middlewares/internalAuthMiddleware.js';
import { canonicalIngestionJsonParser } from '../middlewares/scopedJsonBodyMiddleware.js';

const router = Router();
router.post('/repositories/upsert', requireInternalSecret, canonicalIngestionJsonParser, upsertRepositories);
router.post('/trending/snapshots', requireInternalSecret, canonicalIngestionJsonParser, ingestTrendingSnapshot);
export default router;
