const express = require("express");
const cors = require("cors");
const activityRoutes = require("./routes/activityRoutes");
const commentRoutes = require("./routes/commentRoutes");
const userRoutes = require("./routes/userRoutes");
const recommendationRoutes = require("./routes/recommendationRoutes");

const app = express();

// Global middleware used by every route.
app.use(cors());
app.use(express.json());

// Will restrict later for now it is fine as it is in development

// Basic health route to confirm the backend is running.
app.get("/", (_req, res) => {
  res.json({ message: "GH Social backend is running" });
});

// Activity API routes.
app.use("/api/activity", activityRoutes);

// Comment API routes.
app.use("/api/comment", commentRoutes);

// User API routes.
app.use("/api/users", userRoutes);

// Feed and Feedback API routes.
app.use("/api", recommendationRoutes);

module.exports = app;
