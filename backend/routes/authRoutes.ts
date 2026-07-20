import { Router } from 'express';
import {
  confirmPasswordReset,
  exchangeAuthCode,
  exchangeLocalSupabaseSession,
  getOAuthUrl,
  handleOAuthCallback,
  login,
  logout,
  refreshToken,
  requestPasswordReset,
  signUp,
  startLocalOAuth,
} from '../controllers/authController.js';

const router: Router = Router();

// Public routes
router.post('/signup', signUp);
router.post('/login', login);
router.get('/oauth/:provider', getOAuthUrl);
router.get('/local/start/:provider', startLocalOAuth);
router.post('/local/session', exchangeLocalSupabaseSession);
router.post('/refresh', refreshToken);
router.post('/logout', logout);
router.post('/password/reset/request', requestPasswordReset);
router.post('/password/reset/confirm', confirmPasswordReset);
router.get('/callback', handleOAuthCallback);

// POST /api/auth/exchange
router.post('/exchange', exchangeAuthCode);

export default router;
