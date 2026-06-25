import { Request, Response } from 'express'; 
import { FeedService } from '../services/feedService.js';
import { AuthRequest } from '../middlewares/authMiddleware.js';

const feedService = new FeedService();

export const receiveMlRecommendations = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, repoIds } = req.body;

    // Validation check: Make sure Subhro's service sent the correct payload format
    if (!userId || !Array.isArray(repoIds)) {
       res.status(400).json({ 
        success: false, 
        message: 'Invalid payload format. Expected "userId" (string) and "repoIds" (array of strings).' 
      });
       return;
    }

    // Trigger your background data stitching and caching pipeline
    await feedService.processAndCacheBatch(userId, repoIds);

    // Respond back to the ML service that the batch was successfully queued
     res.status(200).json({ 
      success: true, 
      message: `Successfully received and cached ${repoIds.length} repositories for user.` 
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
  try {
    // Retrieve authenticated userId, with a query param fallback for local development/testing
    const userId = req.user?.userId || (req.query.userId as string);

    if (!userId) {
       res.status(400).json({ success: false, message: 'Missing userId parameter.' });
       return;
    }

    const feed = await feedService.getCachedFeed(userId);

    res.status(200).json({
      success: true,
      count: feed.length,
      data: feed
    });
  } catch (error) {
    console.error('[FeedController] Failed to serve mobile feed:', error);
     res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

export const postFeedback = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId || req.body.userId;
    const { repoId, action } = req.body;

    if (!userId || !repoId || !action) {
      res.status(400).json({ success: false, message: 'Missing userId, repoId, or action.' });
      return;
    }

    await feedService.submitFeedback(userId, repoId, action);

    res.status(200).json({
      success: true,
      message: 'Feedback processed successfully.'
    });
  } catch (error) {
    console.error('[FeedController] Failed to process feedback:', error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};