const recommendationService = require("../services/recommendationService");
const activityService = require("../services/activityService");
const { sendError, sendSuccess } = require("../utils/response");

/**
 * GET /api/feed/:userId
 * Retrieves the next batch of recommendation repository cards for the user.
 */
const getFeed = async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return sendError(res, 400, "userId parameter is required.");
  }

  try {
    const feed = await recommendationService.getFeed(userId);
    return sendSuccess(res, 200, feed);
  } catch (err) {
    console.error(`❌ Error fetching feed for user ${userId}:`, err);
    return sendError(res, 500, "Internal server error while fetching recommendation feed.");
  }
};

/**
 * POST /api/feedback
 * Records user swipe feedback, logs it to Supabase activity table,
 * and forwards the event to the ML service.
 */
const submitFeedback = async (req, res) => {
  const { user_id: userId, repo_id: repoId, action, time_spent: timeSpent } = req.body;

  if (!userId || !repoId || !action) {
    return sendError(res, 400, "Missing required fields: user_id, repo_id, and action are all required.");
  }

  const actionLower = action.toLowerCase();
  const validActions = ["click", "like", "save", "skip"];
  if (!validActions.includes(actionLower)) {
    return sendError(res, 400, `Invalid action: '${action}'. Supported actions are: ${validActions.join(", ")}`);
  }

  try {
    // 1. Sync interaction to Supabase activity table
    let existingActivity = null;
    try {
      const { data, error } = await activityService.getActivityByUserAndRepo(userId, repoId);
      if (error && error.code !== "PGRST116") {
        console.warn("⚠️ Failed to fetch existing activity:", error.message);
      } else {
        existingActivity = data;
      }
    } catch (fetchErr) {
      console.warn("⚠️ Exception during existing activity fetch:", fetchErr.message);
    }

    let isSaved = actionLower === "save";
    let likelihoodCount = actionLower === "like" ? 1 : 0;

    if (existingActivity) {
      isSaved = existingActivity.is_saved || isSaved;
      likelihoodCount = (existingActivity.likelihood_count || 0) + (actionLower === "like" ? 1 : 0);

      const updateData = {
        is_saved: isSaved,
        likelihood_count: likelihoodCount,
        ...(timeSpent && { time_spent: timeSpent })
      };

      const { error: updateError } = await activityService.updateActivityByUserAndRepo(userId, repoId, updateData);
      if (updateError) {
        console.error("❌ Failed to update activity in Supabase:", updateError.message);
      }
    } else {
      const createData = {
        user_id: userId,
        repo_id: repoId,
        is_saved: isSaved,
        likelihood_count: likelihoodCount,
        ...(timeSpent && { time_spent: timeSpent })
      };

      const { error: createError } = await activityService.createActivity(createData);
      if (createError) {
        console.error("❌ Failed to create activity in Supabase:", createError.message);
      }
    }

    // 2. Forward to FastAPI service to shift embeddings and invalidate Postgres cached batches
    const forwardSuccess = await recommendationService.sendFeedback(userId, repoId, actionLower);

    if (!forwardSuccess) {
      console.warn("⚠️ Feedback forwarding to ML service failed or returned error.");
      // We still return 202 to the frontend since database write & local cache invalidation completed
    }

    return sendSuccess(res, 202, {
      status: "accepted",
      message: "Feedback processed successfully"
    });
  } catch (err) {
    console.error("❌ Error in submitFeedback controller:", err);
    return sendError(res, 500, "Internal server error while processing feedback.");
  }
};

module.exports = {
  getFeed,
  submitFeedback
};
