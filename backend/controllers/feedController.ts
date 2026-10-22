import { Request, Response } from 'express'; 
import { FeedService } from '../services/feedService.js';
import { type AuthRequest } from '../middlewares/authMiddleware.js';
import crypto from 'node:crypto';
import { getV2FeatureFlags, inRolloutCohort } from '../config/features.js';
import { getApplicationRuntime } from '../runtime/applicationRuntime.js';
import { FeedRequestInProgressError } from '../services/feedV2Service.js';
import { isValidUuid } from '../utils/validators.js';

const feedService = new FeedService();

export const receiveMlRecommendations = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, recommendations } = req.body;

    if (!userId || !Array.isArray(recommendations)) {
       res.status(400).json({ 
        success: false, 
        message: 'Invalid payload format. Expected "userId" and "recommendations" array.' 
      });
       return;
    }

    await feedService.processAndCacheBatch(userId, recommendations);

     res.status(200).json({ 
      success: true, 
      message: `Successfully received and cached ${recommendations.length} recommendations for user.` 
    });
  } catch (error) {
    console.error('[FeedController] Internal pipeline failure:', error);
     res.status(500).json({ 
      success: false, 
      message: 'Internal server error while processing delivery pipeline.' 
    });
  }
};

export const getFeedForMobile = async (req: AuthRequest, res: Response): Promise<void> => {
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', cancel);
  try {
    const userId = req.user?.userId;

    if (!userId) {
       res.status(401).json({ success: false, message: 'Authentication required.' });
       return;
    }

    const flags = getV2FeatureFlags();
    if (flags.FEED_V2 && inRolloutCohort(userId, 'FEED_V2_CANARY')) {
      const runtime = getApplicationRuntime();
      const requestHeader = req.header('idempotency-key') ?? req.header('x-request-id');
      const sessionHeader = req.header('x-session-id');
      const response = await runtime.feed.getFeed(userId, {
        feed_request_id: requestHeader && isValidUuid(requestHeader) ? requestHeader : crypto.randomUUID(),
        session_id: sessionHeader && isValidUuid(sessionHeader) ? sessionHeader : crypto.randomUUID(),
        limit: 10,
        cursor: null,
      }, controller.signal);
      if (controller.signal.aborted) return;
      const data = response.items.map((item) => ({
        ...item.repository,
        score: item.score,
        recommendation_source: item.source,
        model_version: item.model_version,
        serve_id: response.serve_id,
        position: item.position,
      }));
      res.status(200).json({ success: true, count: data.length, data, v2: {
        serve_id: response.serve_id, feed_version: response.feed_version, source: response.source,
      } });
      return;
    }

    const feed = await feedService.getOrGenerateFeed(userId);

    if (inRolloutCohort(userId, 'FEED_V2_SHADOW')) {
      const runtime = getApplicationRuntime();
      if (runtime.shadow) {
        const ids = feed.flatMap((item) => typeof item?.repo_id === 'string' ? [item.repo_id] : []);
        void runtime.shadow.run(userId, ids);
      }
    }

    res.status(200).json({
      success: true,
      count: feed.length,
      data: feed
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error instanceof FeedRequestInProgressError) {
      res.setHeader('Retry-After', '1');
      res.status(409).json({ success: false, message: error.message });
      return;
    }
    console.error('[FeedController] Failed to serve mobile feed:', error);
     res.status(500).json({ success: false, message: 'Internal server error.' });
  } finally {
    res.removeListener('close', cancel);
  }
};
