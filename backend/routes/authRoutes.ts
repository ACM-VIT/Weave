import { Router } from 'express';
import {
  confirmPasswordReset,
  continueOAuth,
  exchangeAuthCode,
  getOAuthUrl,
  handleOAuthCallback,
  login,
  logout,
  refreshToken,
  requestPasswordReset,
  signUp,
} from '../controllers/authController.js';
import { githubUnlinkRoutes } from '../runtime/githubUnlink.js';
import { GITHUB_UNLINK_COOKIE } from './githubUnlinkRoutes.js';

const router: Router = Router();

// Public routes
router.post('/signup', signUp);
router.post('/login', login);
router.get('/oauth/continue', continueOAuth);
router.get('/oauth/:provider', getOAuthUrl);
router.post('/refresh', refreshToken);
router.post('/logout', logout);
router.post('/password/reset/request', requestPasswordReset);
router.post('/password/reset/confirm', confirmPasswordReset);
router.use('/github-unlink', (req, res, next) => githubUnlinkRoutes().publicRoutes(req, res, next));
router.get('/callback', (req, res) => req.cookies?.[GITHUB_UNLINK_COOKIE]
  ? githubUnlinkRoutes().callback(req, res) : handleOAuthCallback(req, res));

// POST /api/auth/exchange
router.post('/exchange', exchangeAuthCode);

export default router;
