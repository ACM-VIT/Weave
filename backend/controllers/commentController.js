const commentService = require("../services/commentService");
const { sendError, sendSuccess } = require("../utils/response");

// Return every comment row.
const getAllComments = async (_req, res) => {
  const { data, error } = await commentService.getAllComments();

  if (error) {
    return sendError(res, 500, error.message);
  }

  return sendSuccess(res, 200, data);
};

// Return comment rows for a specific repository.
const getCommentsByRepo = async (req, res) => {
  const { repoId } = req.params;
  const { data, error } = await commentService.getCommentsByRepo(repoId);

  if (error) {
    return sendError(res, 500, error.message);
  }

  return sendSuccess(res, 200, data);
};

// Return comment rows for a specific user.
const getCommentsByUser = async (req, res) => {
  const { userId } = req.params;
  const { data, error } = await commentService.getCommentsByUser(userId);

  if (error) {
    return sendError(res, 500, error.message);
  }

  return sendSuccess(res, 200, data);
};

// Return replies for a specific parent comment.
const getRepliesByParentComment = async (req, res) => {
  const { parentCommentId } = req.params;
  const { data, error } = await commentService.getRepliesByParentComment(parentCommentId);

  if (error) {
    return sendError(res, 500, error.message);
  }

  return sendSuccess(res, 200, data);
};

const isNotFoundError = (error) => error && error.code === "PGRST116";

// Return one comment row by its primary key.
const getCommentById = async (req, res) => {
  const { commentId } = req.params;

  try {
    const { data, error } = await commentService.getCommentById(commentId);

    if (isNotFoundError(error)) {
      return sendError(res, 404, "Comment not found");
    }

    if (error) {
      return sendError(res, 500, error.message);
    }

    return sendSuccess(res, 200, data);
  } catch (err) {
    console.error("Error in getCommentById:", err);
    return sendError(res, 500, "Internal server error.");
  }
};

// Create a new comment row.
const createComment = async (req, res) => {
  try {
    const { data, error } = await commentService.createComment(req.body);

    if (error) {
      return sendError(res, 400, error.message);
    }

    return sendSuccess(res, 201, data);
  } catch (err) {
    console.error("Error in createComment:", err);
    return sendError(res, 500, "Internal server error.");
  }
};

// Update one comment directly by primary key.
const updateCommentById = async (req, res) => {
  const { commentId } = req.params;

  try {
    const { data, error } = await commentService.updateCommentById(commentId, req.body);

    if (isNotFoundError(error)) {
      return sendError(res, 404, "Comment not found");
    }

    if (error) {
      return sendError(res, 400, error.message);
    }

    return sendSuccess(res, 200, data);
  } catch (err) {
    console.error("Error in updateCommentById:", err);
    return sendError(res, 500, "Internal server error.");
  }
};

// Delete one comment directly by primary key.
const deleteCommentById = async (req, res) => {
  const { commentId } = req.params;

  try {
    const { error } = await commentService.deleteCommentById(commentId);

    if (error) {
      return sendError(res, 400, error.message);
    }

    return res.status(204).send();
  } catch (err) {
    console.error("Error in deleteCommentById:", err);
    return sendError(res, 500, "Internal server error.");
  }
};

module.exports = {
  getAllComments,
  getCommentsByRepo,
  getCommentsByUser,
  getRepliesByParentComment,
  getCommentById,
  createComment,
  updateCommentById,
  deleteCommentById,
};
