import { Router } from 'express';

import { operationsStatus, replayOutbox, supersedeOutbox } from '../controllers/operationsController.js';
import { requireInternalSecret } from '../middlewares/internalAuthMiddleware.js';

const router = Router();
router.use(requireInternalSecret);
router.get('/status', operationsStatus);
router.post('/outbox/:outboxId/replay', replayOutbox);
router.post('/outbox/:outboxId/supersede', supersedeOutbox);
export default router;
