const express = require("express");
const recommendationController = require("../controllers/recommendationController");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /api/feed/:userId - Get next batch of 15 recommendation repository cards (requires authentication)
router.get("/feed/:userId", requireAuth, recommendationController.getFeed);

// POST /api/feedback - Submit swipe feedback (like, save, skip, click) (requires authentication)
router.post("/feedback", requireAuth, recommendationController.submitFeedback);

module.exports = router;
