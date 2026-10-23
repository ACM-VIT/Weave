import { Router } from 'express';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import { GitHubActivityImportClient, GitHubActivityImportError } from '../services/githubActivityImport.js';
import { GitHubImportConsentService } from '../services/githubImportConsentService.js';
import redis from '../config/redis.js';
import { isValidUuid } from '../utils/validators.js';
import { sendControllerError, sendError, sendSuccess } from '../utils/response.js';

export function createGithubImportRouter(injected?: GitHubImportConsentService) {
  const router = Router();
  let service = injected;
  const getService = () => {
    if (!service) {
      service = new GitHubImportConsentService({ collect: async (identity, signal) => {
        const token = process.env.GITHUB_TOKEN?.trim();
        if (!token) throw Object.assign(new Error('Public GitHub import is temporarily unavailable. Choose preferences manually.'), { statusCode: 503 });
        return new GitHubActivityImportClient({ token }).collect(identity, signal);
      } }, redis);
    }
    return service;
  };
  router.use((req: AuthRequest, res, next) => {
    if (!req.user?.userId) { sendError(res, 401, 'Authentication required.'); return; }
    next();
  });
  router.get('/', async (req: AuthRequest, res) => {
    try { sendSuccess(res, 200, await getService().status(req.user!.userId)); }
    catch (error) { sendControllerError(res, error); }
  });
  router.post('/preview', async (req: AuthRequest, res) => {
    if (!req.body || Object.keys(req.body).some(key => key !== 'consent')) { sendError(res, 400, 'Only explicit import consent is accepted.'); return; }
    const cancelled = new AbortController();
    const abort = () => { if (!res.writableEnded) cancelled.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    try { sendSuccess(res, 200, await getService().preview(req.user!.userId, req.body.consent, cancelled.signal)); }
    catch (error) {
      if (cancelled.signal.aborted) return;
      if (error instanceof GitHubActivityImportError) {
        if (error.retryAfterSeconds) res.setHeader('Retry-After', error.retryAfterSeconds);
        sendError(res, error.code === 'provider_identity_changed' ? 409 : 503, 'Public activity could not be verified. Retry later or choose preferences manually.');
      } else sendControllerError(res, error);
    } finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
  });
  router.post('/accept', async (req: AuthRequest, res) => {
    if (!isValidUuid(req.body?.snapshot_id) || Object.keys(req.body ?? {}).some(key => key !== 'snapshot_id')) {
      sendError(res, 400, 'A valid import snapshot ID is required.'); return;
    }
    try { sendSuccess(res, 200, await getService().accept(req.user!.userId, req.body.snapshot_id)); }
    catch (error) { sendControllerError(res, error); }
  });
  router.delete('/', async (req: AuthRequest, res) => {
    try { sendSuccess(res, 200, await getService().revoke(req.user!.userId)); }
    catch (error) { sendControllerError(res, error); }
  });
  return router;
}
