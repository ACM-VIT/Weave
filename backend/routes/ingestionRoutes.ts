import { Router } from 'express';

import { ingestTrendingSnapshot, upsertRepositories } from '../controllers/ingestionController.js';
import { requireInternalSecret } from '../middlewares/internalAuthMiddleware.js';
import { canonicalIngestionJsonParser } from '../middlewares/scopedJsonBodyMiddleware.js';

import { corpusManifestController } from '../controllers/corpusManifestController.js';
import { CorpusManifestService } from '../services/corpusManifestService.js';
import { postgresCorpusManifest } from '../adapters/postgresCorpusManifest.js';
import { sqlClient } from '../db/index.js';

const router = Router();
router.get('/repositories/manifest', requireInternalSecret, corpusManifestController(
  () => new CorpusManifestService(postgresCorpusManifest(sqlClient), process.env.JWT_SECRET ?? ''),
));
router.post('/repositories/upsert', requireInternalSecret, canonicalIngestionJsonParser, upsertRepositories);
router.post('/trending/snapshots', requireInternalSecret, canonicalIngestionJsonParser, ingestTrendingSnapshot);
export default router;
