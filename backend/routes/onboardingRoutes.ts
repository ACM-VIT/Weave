import { Router } from 'express';
import {
  getOnboardingStatus,
  setupOnboarding,
  syncGitHub,
} from '../controllers/onboardingController.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router: Router = Router();

router.use(requireAuth);

router.get('/status', getOnboardingStatus);
router.put('/setup', setupOnboarding);
router.post('/sync-github', syncGitHub);

export default router;
