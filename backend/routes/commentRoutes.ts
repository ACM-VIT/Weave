import { Router } from 'express';
import {
  getAllComments,
  getCommentsByRepo,
  getCommentsByUser,
  getRepliesByParentComment,
  getCommentById,
  createComment,
  updateCommentById,
  deleteCommentById,
} from '../controllers/commentController.js';

const router: Router = Router();

// Routes only connect URLs to controller functions.

// Get all comment records.
router.get('/', getAllComments);

// Get all comment records for one repository.
router.get('/repo/:repoId', getCommentsByRepo);

// Get all comment records for one user.
router.get('/user/:userId', getCommentsByUser);

// Get replies for one parent comment.
router.get('/parent/:parentCommentId', getRepliesByParentComment);

// Get one comment record by comment id.
router.get('/:commentId', getCommentById);

// Create a new comment record.
router.post('/', createComment);

// Update one comment record by comment id.
router.patch('/:commentId', updateCommentById);

// Delete one comment record by comment id.
router.delete('/:commentId', deleteCommentById);

export default router;
