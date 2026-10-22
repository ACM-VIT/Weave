import type { Response } from 'express';

import type { AuthRequest } from '../middlewares/authMiddleware.js';
import { isValidUuid } from '../utils/validators.js';
import { getApplicationRuntime } from '../runtime/applicationRuntime.js';
import {
  FeedRequestInProgressError,
  PersonalizedFeedUnavailableError,
} from '../services/feedV2Service.js';
import { InvalidFeedCursorError, StaleFeedCursorError } from '../services/feedCursor.js';

export async function getFeedV2(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const { feed_request_id, session_id, limit = 10, cursor = null } = req.body ?? {};
  if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
  const runtime = getApplicationRuntime();
  if (!isValidUuid(feed_request_id) || !isValidUuid(session_id)) {
    res.status(400).json({ error: 'feed_request_id and session_id must be UUIDs.' }); return;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 || (cursor !== null && typeof cursor !== 'string')) {
    res.status(400).json({ error: 'limit must be 1-25 and cursor must be null or a string.' }); return;
  }
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', cancel);
  try {
    const response = await runtime.feed.getFeed(userId, { feed_request_id, session_id, limit, cursor }, controller.signal);
    if (!controller.signal.aborted) res.status(200).json(response);
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error instanceof InvalidFeedCursorError) {
      res.status(400).json({ error: error.message,
        ...(error instanceof StaleFeedCursorError ? { code: error.code } : {}),
      });
      return;
    }
    if (error instanceof FeedRequestInProgressError) {
      res.setHeader('Retry-After', '1');
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof PersonalizedFeedUnavailableError) {
      console.error('[FeedV2Controller] Personalized feed unavailable:', error.cause ?? error);
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        error: error.message,
        code: error.code,
        retryable: true,
      });
      return;
    }
    console.error('[FeedV2Controller] Failed:', error);
    res.status(503).json({ error: 'Feed is temporarily unavailable.' });
  } finally {
    res.removeListener('close', cancel);
  }
}
