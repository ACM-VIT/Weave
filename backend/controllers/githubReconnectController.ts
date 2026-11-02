import type { Response } from 'express';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import { db } from '../db/index.js';
import { appOauthCodes as oauthCodes, appUsers as users } from '../db/v2Schema.js';
import { clientCodeChallengeFromVerifier } from '../services/oauthPkceService.js';
import { isValidUuid } from '../utils/validators.js';
import { sendControllerError, sendError, sendSuccess } from '../utils/response.js';

// Confirm same-account GitHub reauthentication without issuing a login session.
// A code for another account cannot replace cookies or the current app token.
export async function confirmGithubReconnect(req: AuthRequest, res: Response): Promise<void> {
  const code = req.body?.code, verifier = req.body?.code_verifier;
  const challenge = typeof verifier === 'string' ? clientCodeChallengeFromVerifier(verifier) : null;
  if (!req.user?.userId) return sendError(res, 401, 'Authentication required.');
  if (!isValidUuid(code) || !challenge || Object.keys(req.body ?? {}).some(key => !['code', 'code_verifier'].includes(key))) {
    return sendError(res, 400, 'A valid authorization code and verifier are required.');
  }
  try {
    const [confirmed] = await db.delete(oauthCodes).where(and(
      eq(oauthCodes.code, code), eq(oauthCodes.userId, req.user.userId),
      eq(oauthCodes.clientCodeChallenge, challenge), gt(oauthCodes.expiresAt, new Date()),
      sql`exists(select 1 from ${users} where ${users.userId} = ${oauthCodes.userId}
        and ${users.githubId} is not null and ${users.githubIdentityVerifiedAt} is not null)`,
    )).returning({ userId: oauthCodes.userId });
    if (!confirmed) return sendError(res, 409, 'Reconnect with the GitHub identity belonging to this Weave account. Your current session has been kept.');
    sendSuccess(res, 200, { linked: true });
  } catch (error) { sendControllerError(res, error as Error); }
}
