import express from 'express';
import * as boardController from '../controllers/boardController.js';

const router = express.Router();

// Create a board. Body: { user_id, board_name, visibility?, description? }
router.post('/', boardController.createBoard);

// List all boards for a user. Path param: userId
router.get('/user/:userId', boardController.getBoardsByUser);

// Get a single board by id. Path param: boardId
router.get('/:boardId', boardController.getBoardById);

// Add a saved repo to a board. Body: { repo_id }
router.post('/:boardId/repos', boardController.addRepoToBoard);

// Remove a repo from a board. Path params: boardId, repoId
router.delete('/:boardId/repos/:repoId', boardController.removeRepoFromBoard);

// Delete a board entirely. Path param: boardId
router.delete('/:boardId', boardController.deleteBoardById);

// List repos saved on a board. Path param: boardId
router.get('/:boardId/repos', boardController.getReposForBoard);

export default router;
