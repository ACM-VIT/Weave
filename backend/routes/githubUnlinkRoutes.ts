import { Router, type Request, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../middlewares/authMiddleware.js';
import type { GithubUnlinkFlow } from '../services/githubUnlinkFlow.js';
import { CLIENT_CODE_CHALLENGE_PATTERN } from '../services/oauthPkceService.js';
import { resolveBackendCallbackUrl, resolveClientRedirect } from '../security/originPolicy.js';
import { sendControllerError, sendError, sendSuccess } from '../utils/response.js';

export const GITHUB_UNLINK_COOKIE = 'github_unlink_attempt';
export function createGithubUnlinkRoutes(options: {
  flow: GithubUnlinkFlow; backendUrl: string; clientUrl: string; clientRedirects?: string[]; nodeEnv?: string; port?: string;
}) {
  const authenticated = Router(), publicRoutes = Router();
  const cookie = { httpOnly: true, secure: options.nodeEnv === 'production', sameSite: 'lax' as const, path: '/api/auth', maxAge: 300_000 };
  const clearCookie = { httpOnly: true, secure: cookie.secure, sameSite: cookie.sameSite, path: cookie.path };
  const callbackUrl = (req: Request) => resolveBackendCallbackUrl(req.get('host'), options.backendUrl, options.port, options.nodeEnv);
  const redirectError = (res: Response, error?: unknown) => {
    const context = error && typeof error === 'object' ? error as { clientRedirect?: unknown; unlinkReason?: unknown } : {};
    const target = new URL(resolveClientRedirect(context.clientRedirect, options.clientUrl, options.clientRedirects ?? [], options.nodeEnv));
    target.searchParams.set('unlink_error', context.unlinkReason === 'last_identity' ? 'last_identity' : 'reauthentication_failed');
    res.redirect(302, target.toString());
  };
  authenticated.post('/start', requireAuth, async (req: AuthRequest, res) => {
    if (!req.body || req.body.confirmation !== 'disconnect-github'
      || typeof req.body.code_challenge !== 'string' || !CLIENT_CODE_CHALLENGE_PATTERN.test(req.body.code_challenge)
      || Object.keys(req.body).some(key => !['confirmation', 'code_challenge', 'redirect_uri'].includes(key))) {
      sendError(res, 400, 'Explicit disconnect confirmation and client PKCE are required.'); return;
    }
    try {
      const redirect = resolveClientRedirect(req.body.redirect_uri, options.clientUrl, options.clientRedirects ?? [], options.nodeEnv);
      const attempt = await options.flow.start(req.user!.userId, redirect, callbackUrl(req), req.body.code_challenge);
      const continuation = new URL('/api/auth/github-unlink/continue', callbackUrl(req));
      continuation.searchParams.set('unlink_attempt', attempt.state);
      sendSuccess(res, 200, { url: continuation.toString() });
    } catch (error) { sendControllerError(res, error); }
  });
  publicRoutes.get('/continue', async (req, res) => {
    const state = req.query.unlink_attempt;
    if (typeof state !== 'string') { sendError(res, 400, 'Invalid unlink authorization.'); return; }
    try {
      const attempt = await options.flow.continuation(state);
      // Starting one explicit purpose retires the other browser cookie; the
      // dedicated Redis namespaces still reject purpose swaps and replay.
      res.clearCookie('oauth_attempt', clearCookie);
      res.cookie(GITHUB_UNLINK_COOKIE, state, cookie);
      res.redirect(302, attempt.url);
    } catch (error) { sendControllerError(res, error); }
  });
  const callback = async (req: Request, res: Response) => {
    const state = req.cookies?.[GITHUB_UNLINK_COOKIE];
    res.clearCookie(GITHUB_UNLINK_COOKIE, clearCookie);
    if (typeof state !== 'string') { redirectError(res); return; }
    if (typeof req.query.code !== 'string' || req.query.error) {
      try { redirectError(res, await options.flow.cancelCallback(state)); }
      catch (error) { redirectError(res, error); }
      return;
    }
    try {
      const proof = await options.flow.callback(state, req.query.code);
      const redirect = new URL(proof.clientRedirect); redirect.searchParams.set('unlink_code', proof.completion);
      res.redirect(302, redirect.toString());
    } catch (error) { redirectError(res, error); }
  };
  authenticated.post('/finish', requireAuth, async (req: AuthRequest, res) => {
    if (typeof req.body?.unlink_code !== 'string' || typeof req.body?.code_verifier !== 'string'
      || req.body.confirmation !== 'disconnect-github'
      || Object.keys(req.body).some(key => !['unlink_code', 'code_verifier', 'confirmation'].includes(key))) {
      sendError(res, 400, 'An owner-bound unlink confirmation is required.'); return;
    }
    try {
      const result = await options.flow.finish(req.user!.userId, req.body.unlink_code, req.body.code_verifier);
      sendSuccess(res, result.status === 'pending' ? 202 : 200, result);
    } catch (error) { sendControllerError(res, error); }
  });
  authenticated.post('/status', requireAuth, async (req: AuthRequest, res) => {
    if (Object.keys(req.body ?? {}).length) { sendError(res, 400, 'Unlink status derives its owner from authentication.'); return; }
    try { sendSuccess(res, 200, await options.flow.reconcile(req.user!.userId)); }
    catch (error) { sendControllerError(res, error); }
  });
  return { authenticated, publicRoutes, callback };
}
