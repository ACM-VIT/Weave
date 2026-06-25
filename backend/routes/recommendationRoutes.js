const express = require("express");
const recommendationController = require("../controllers/recommendationController");

const router = express.Router();

// GET /api/feed/:userId - Get next batch of 15 recommendation repository cards
router.get("/feed/:userId", recommendationController.getFeed);

// POST /api/feedback - Submit swipe feedback (like, save, skip, click)
router.post("/feedback", recommendationController.submitFeedback);

module.exports = router;
